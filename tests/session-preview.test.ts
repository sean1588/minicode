import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionPreview,
  isCompactionSummaryMessage,
} from "../src/session/session-preview.js";

test("isCompactionSummaryMessage detects compacted summary stubs", () => {
  assert.equal(
    isCompactionSummaryMessage({
      role: "user",
      content: "[Conversation Summary — earlier messages were compacted to save context]\nSummary text",
    }),
    true,
  );
  assert.equal(
    isCompactionSummaryMessage({
      role: "assistant",
      content: "[Conversation Summary — earlier messages were compacted to save context]\nSummary text",
    }),
    false,
  );
});

test("buildSessionPreview filters compaction summaries and keeps the last ten messages", () => {
  const preview = buildSessionPreview([
    {
      role: "user",
      content: "[Conversation Summary — earlier messages were compacted using LLM summarization]\nSummary text",
    },
    { role: "user", content: "message-1" },
    { role: "assistant", content: "message-2" },
    { role: "user", content: "message-3" },
    { role: "assistant", content: "message-4" },
    { role: "user", content: "message-5" },
    { role: "assistant", content: "message-6" },
    { role: "user", content: "message-7" },
    { role: "assistant", content: "message-8" },
    { role: "user", content: "message-9" },
    { role: "assistant", content: "message-10" },
    { role: "user", content: "message-11" },
  ]);

  assert.equal(preview.length, 10);
  assert.equal(preview[0]?.content, "message-2");
  assert.equal(preview[9]?.content, "message-11");
  assert.ok(
    preview.every((message) => !message.content.startsWith("[Conversation Summary")),
  );
});

test("buildSessionPreview preserves tool messages in order", () => {
  const preview = buildSessionPreview([
    {
      role: "assistant",
      content: "Let me check that",
      toolCalls: [{ id: "tool-1", name: "search", input: { query: "foo" } }],
    },
    {
      role: "tool",
      toolCallId: "tool-1",
      toolName: "search",
      content: "search output",
    },
    {
      role: "assistant",
      content: "Found it",
    },
  ]);

  assert.deepEqual(
    preview.map((message) => message.role),
    ["assistant", "tool", "assistant"],
  );
});
