import { randomUUID } from "node:crypto";

import type { ModelClient, SessionMessage } from "../agent/types.js";

function estimateMessageTokens(message: SessionMessage): number {
  if (message.role === "tool") {
    return Math.ceil((message.toolName.length + message.content.length) / 4);
  }

  const toolCallTokens =
    message.role === "assistant" && message.toolCalls?.length
      ? Math.ceil(JSON.stringify(message.toolCalls).length / 4)
      : 0;

  return Math.ceil(message.content.length / 4) + toolCallTokens;
}

/**
 * Summarize a tool result into a compact one-liner.
 * Keeps the tool name and a brief excerpt of the output.
 */
function summarizeToolResult(content: string, maxLen = 200): string {
  const firstLine = content.split("\n")[0] ?? "";
  const lineCount = content.split("\n").length;
  const excerpt =
    firstLine.length > maxLen
      ? firstLine.slice(0, maxLen) + "..."
      : firstLine;
  return `[summary: ${excerpt} (${lineCount} lines, ${content.length} chars)]`;
}

export interface SessionSnapshot {
  id: string;
  createdAt: string;
  messages: SessionMessage[];
}

export interface CompactionResult {
  removedMessages: number;
  summaryTokens: number;
  previousTokens: number;
  newTokens: number;
  /**
   * Which strategy actually produced the summary. `compactWithLlm` falls
   * back to mechanical compaction on error, so the method that *attempted*
   * the work isn't always the one that finished it. UI surfaces this so
   * users know whether the LLM call ran (slow, billable) or the
   * deterministic fallback fired (instant, free).
   */
  method: "llm" | "mechanical";
}

export class Session {
  readonly id: string;
  readonly createdAt: Date;

  private readonly messages: SessionMessage[];

  constructor(id: string = randomUUID(), createdAt?: Date) {
    this.id = id;
    this.createdAt = createdAt ?? new Date();
    this.messages = [];
  }

  toJSON(): SessionSnapshot {
    return {
      id: this.id,
      createdAt: this.createdAt.toISOString(),
      messages: this.getMessages(),
    };
  }

  static fromJSON(snapshot: SessionSnapshot): Session {
    const session = new Session(snapshot.id, new Date(snapshot.createdAt));
    for (const message of snapshot.messages) {
      session.addMessage(message);
    }
    return session;
  }

  addMessage(message: SessionMessage): void {
    this.messages.push(message);
  }

  getMessages(): SessionMessage[] {
    return [...this.messages];
  }

  getTokenEstimate(): number {
    return this.messages.reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    );
  }

  /**
   * Progressive context eviction with three phases:
   *
   * Phase 1 — Shrink: Replace old tool result contents with compact summaries.
   *   Tool outputs are ephemeral (file contents, search results) — the model
   *   already extracted what it needed. Shrinking preserves the *fact* that a
   *   tool was called and a rough sense of the result, without the full payload.
   *
   * Phase 2 — Drop: Remove the oldest complete message chunks (assistant +
   *   tool results, or standalone messages) as before.
   *
   * Phase 3 — Emergency: If still over budget after dropping all removable
   *   messages, shrink tool results in the protected (recent) window too.
   */
  trim(maxTokens: number, keepRecentMessages: number): void {
    if (keepRecentMessages < 0) {
      return;
    }

    // Phase 1: Shrink old tool results before dropping anything
    if (this.getTokenEstimate() > maxTokens) {
      const protectedStart = this.getProtectedStart(keepRecentMessages);
      this.shrinkToolResults(0, protectedStart);
    }

    // Phase 2: Drop oldest chunks (existing behavior)
    while (
      this.getTokenEstimate() > maxTokens &&
      this.messages.length > keepRecentMessages
    ) {
      const protectedStart = this.getProtectedStart(keepRecentMessages);
      if (protectedStart <= 0) {
        break;
      }

      const removed = this.removeOldestChunk(protectedStart);
      if (!removed) {
        break;
      }
    }

    // Phase 3: If still over budget, shrink tool results in recent messages too
    if (this.getTokenEstimate() > maxTokens) {
      this.shrinkToolResults(0, this.messages.length);
    }
  }

  /**
   * Compact the conversation by summarizing old messages into a single
   * context summary message. This preserves the *meaning* of prior exchanges
   * while dramatically reducing token count.
   *
   * @param keepRecentMessages Number of recent messages to preserve verbatim.
   * @returns CompactionResult with stats, or null if nothing to compact.
   */
  compact(keepRecentMessages: number): CompactionResult | null {
    const protectedStart = this.getProtectedStart(keepRecentMessages);
    if (protectedStart <= 0) {
      return null;
    }

    const previousTokens = this.getTokenEstimate();
    const oldMessages = this.messages.splice(0, protectedStart);

    // Build a structured summary of the removed conversation
    const summaryParts: string[] = [];
    let currentExchange: string[] = [];

    for (const msg of oldMessages) {
      if (msg.role === "user") {
        // Flush previous exchange
        if (currentExchange.length > 0) {
          summaryParts.push(currentExchange.join("\n"));
          currentExchange = [];
        }
        const truncatedContent =
          msg.content.length > 300
            ? msg.content.slice(0, 300) + "..."
            : msg.content;
        currentExchange.push(`- User asked: ${truncatedContent}`);
      } else if (msg.role === "assistant") {
        const truncatedContent =
          msg.content.length > 300
            ? msg.content.slice(0, 300) + "..."
            : msg.content;
        if (truncatedContent.length > 0) {
          currentExchange.push(`  Agent responded: ${truncatedContent}`);
        }
        if (msg.toolCalls?.length) {
          const toolNames = msg.toolCalls.map((tc) => tc.name).join(", ");
          currentExchange.push(`  Agent called tools: ${toolNames}`);
        }
      } else if (msg.role === "tool") {
        // Just note what tool returned, not the full content
        const brief =
          msg.content.length > 100
            ? msg.content.slice(0, 100) + "..."
            : msg.content;
        currentExchange.push(`  ${msg.toolName} returned: ${brief}`);
      }
    }

    if (currentExchange.length > 0) {
      summaryParts.push(currentExchange.join("\n"));
    }

    const summaryText =
      "[Conversation Summary — earlier messages were compacted to save context]\n" +
      summaryParts.join("\n");

    // Insert the summary as the first message (user role to maintain valid message ordering)
    this.messages.unshift({
      role: "user",
      content: summaryText,
    });

    const newTokens = this.getTokenEstimate();
    const summaryTokens = estimateMessageTokens(this.messages[0]!);

    return {
      removedMessages: oldMessages.length,
      summaryTokens,
      previousTokens,
      newTokens,
      method: "mechanical",
    };
  }

  /**
   * Compact the conversation using an LLM to produce a high-quality summary.
   * The LLM can identify what matters (decisions, modified files, user intent)
   * rather than blindly truncating. Falls back to mechanical compaction on error.
   *
   * @param keepRecentMessages Number of recent messages to preserve verbatim.
   * @param modelClient The model client to use for the summarization call.
   * @param compactionModel The model ID to use (e.g. "zai-org/glm-4.7-flash").
   * @returns CompactionResult with stats, or null if nothing to compact.
   */
  async compactWithLlm(
    keepRecentMessages: number,
    modelClient: ModelClient,
    compactionModel: string,
  ): Promise<CompactionResult | null> {
    const protectedStart = this.getProtectedStart(keepRecentMessages);
    if (protectedStart <= 0) {
      return null;
    }

    const previousTokens = this.getTokenEstimate();
    const oldMessages = this.messages.slice(0, protectedStart);

    // Build a text representation of the old messages for the LLM to summarize
    const conversationText = oldMessages
      .map((msg) => {
        if (msg.role === "user") {
          return `User: ${msg.content}`;
        } else if (msg.role === "assistant") {
          const toolInfo =
            msg.toolCalls?.length
              ? `\n[Called tools: ${msg.toolCalls.map((tc) => tc.name).join(", ")}]`
              : "";
          return `Assistant: ${msg.content}${toolInfo}`;
        } else if (msg.role === "tool") {
          const brief =
            msg.content.length > 500
              ? msg.content.slice(0, 500) + "..."
              : msg.content;
          return `Tool (${msg.toolName}): ${brief}`;
        }
        return "";
      })
      .join("\n\n");

    let summaryText: string;
    try {
      const response = await modelClient.chat({
        model: compactionModel,
        system:
          "You are a conversation summarizer. Produce a concise summary of the conversation below. " +
          "Focus on preserving:\n" +
          "- The user's overall goal and current task\n" +
          "- Key decisions made and their rationale\n" +
          "- Files that were read, created, or modified (with paths)\n" +
          "- Important facts, constraints, or preferences stated by the user\n" +
          "- Current state of progress (what's done, what's pending)\n\n" +
          "Omit: verbose tool outputs, redundant information, intermediate reasoning that led nowhere.\n" +
          "Format the summary as a structured, scannable document. Be concise but thorough.",
        messages: [
          {
            role: "user",
            content: `Summarize this conversation:\n\n${conversationText}`,
          },
        ],
        tools: [],
        maxTokens: 1500,
      });
      summaryText =
        "[Conversation Summary — earlier messages were compacted using LLM summarization]\n" +
        response.text;
    } catch {
      // Fall back to mechanical compaction on any error
      return this.compact(keepRecentMessages);
    }

    // Remove old messages and insert the summary
    this.messages.splice(0, protectedStart);
    this.messages.unshift({
      role: "user",
      content: summaryText,
    });

    const newTokens = this.getTokenEstimate();
    const summaryTokens = estimateMessageTokens(this.messages[0]!);

    return {
      removedMessages: oldMessages.length,
      summaryTokens,
      previousTokens,
      newTokens,
      method: "llm",
    };
  }

  /**
   * Check whether compaction should be auto-triggered.
   * Returns true when token usage exceeds the given threshold ratio.
   */
  shouldCompact(maxTokens: number, thresholdRatio = 0.8): boolean {
    return this.getTokenEstimate() > maxTokens * thresholdRatio;
  }

  /**
   * Shrink tool result messages in the given range by replacing their
   * content with a compact summary. Already-summarized messages are skipped.
   */
  private shrinkToolResults(fromIndex: number, toIndex: number): void {
    for (let i = fromIndex; i < toIndex && i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (
        msg?.role === "tool" &&
        !msg.content.startsWith("[summary:")
      ) {
        this.messages[i] = {
          ...msg,
          content: summarizeToolResult(msg.content),
        };
      }
    }
  }

  private getProtectedStart(keepRecentMessages: number): number {
    let protectedStart = Math.max(0, this.messages.length - keepRecentMessages);
    const boundaryMessage = this.messages[protectedStart];
    if (!boundaryMessage || boundaryMessage.role !== "tool") {
      return protectedStart;
    }

    while (
      protectedStart > 0 &&
      this.messages[protectedStart - 1]?.role === "tool"
    ) {
      protectedStart -= 1;
    }

    const potentialToolCallMessage = this.messages[protectedStart - 1];
    if (
      potentialToolCallMessage?.role === "assistant" &&
      potentialToolCallMessage.toolCalls?.length
    ) {
      protectedStart -= 1;
    }

    return protectedStart;
  }

  private removeOldestChunk(removableCount: number): boolean {
    if (removableCount <= 0 || this.messages.length === 0) {
      return false;
    }

    const first = this.messages[0];
    if (!first) {
      return false;
    }

    if (first.role === "assistant" && first.toolCalls?.length) {
      let removeCount = 1;
      while (
        this.messages[removeCount]?.role === "tool"
      ) {
        removeCount += 1;
      }
      if (removeCount > removableCount) {
        return false;
      }
      this.messages.splice(0, removeCount);
      return true;
    }

    if (first.role === "tool") {
      let removeCount = 1;
      while (
        this.messages[removeCount]?.role === "tool"
      ) {
        removeCount += 1;
      }
      if (removeCount > removableCount) {
        return false;
      }
      this.messages.splice(0, removeCount);
      return true;
    }

    this.messages.splice(0, 1);
    return true;
  }
}
