import type { SessionMessage } from "@minicode/agent-sdk";

export const DEFAULT_SESSION_PREVIEW_LIMIT = 10;
const COMPACTION_SUMMARY_PREFIX = "[Conversation Summary";

export function isCompactionSummaryMessage(message: SessionMessage): boolean {
  return (
    message.role === "user" &&
    message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}

export function buildSessionPreview(
  messages: readonly SessionMessage[],
  limit = DEFAULT_SESSION_PREVIEW_LIMIT,
): SessionMessage[] {
  if (limit <= 0) {
    return [];
  }

  return messages
    .filter((message) => !isCompactionSummaryMessage(message))
    .slice(-limit);
}
