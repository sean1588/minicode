import { randomUUID } from "node:crypto";

import type { SessionMessage } from "../agent/types.js";

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

export interface SessionSnapshot {
  id: string;
  createdAt: string;
  messages: SessionMessage[];
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

  trim(maxTokens: number, keepRecentMessages: number): void {
    if (keepRecentMessages < 0) {
      return;
    }

    while (
      this.getTokenEstimate() > maxTokens &&
      this.messages.length > keepRecentMessages
    ) {
      const protectedStart = this.getProtectedStart(keepRecentMessages);
      if (protectedStart <= 0) {
        return;
      }

      const removed = this.removeOldestChunk(protectedStart);
      if (!removed) {
        return;
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
