import { test } from "node:test";
import assert from "node:assert/strict";

import { Session } from "@sean.holung/minicode-sdk";

test("session stores and returns messages", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "hello" });
  session.addMessage({ role: "assistant", content: "world" });

  const messages = session.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
});

test("trim keeps recent messages while reducing token estimate", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "a".repeat(200) });
  session.addMessage({
    role: "assistant",
    content: "thinking",
    toolCalls: [{ id: "1", name: "read_file", input: { path: "x" } }],
  });
  session.addMessage({
    role: "tool",
    toolCallId: "1",
    toolName: "read_file",
    content: "tool-output",
  });
  session.addMessage({ role: "assistant", content: "done" });

  const before = session.getTokenEstimate();
  session.trim(30, 2);
  const after = session.getTokenEstimate();
  const messages = session.getMessages();

  assert.ok(after <= before);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[1]?.role, "tool");
  assert.equal(messages[2]?.role, "assistant");
});

test("shrinkToolResults does not mutate original message objects", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "go" });
  session.addMessage({
    role: "assistant",
    content: "calling tool",
    toolCalls: [{ id: "t1", name: "read_file", input: { path: "x" } }],
  });
  const toolMsg = {
    role: "tool" as const,
    toolCallId: "t1",
    toolName: "read_file",
    content: "original-tool-output-that-is-long-enough-to-be-summarized",
  };
  session.addMessage(toolMsg);
  session.addMessage({ role: "assistant", content: "done" });

  // Get a reference to the messages before trimming
  const beforeTrim = session.getMessages();
  const toolBefore = beforeTrim.find((m) => m.role === "tool");
  assert.ok(toolBefore);
  const originalContent = toolBefore.content;

  // Trim to trigger shrinkToolResults
  session.trim(30, 2);

  // The original message object captured before trim should be unchanged
  assert.equal(toolBefore.content, originalContent, "original message object should not be mutated");
});

test("shrinkToolResults replaces message in array instead of mutating", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "go" });
  session.addMessage({
    role: "assistant",
    content: "calling tool",
    toolCalls: [{ id: "t1", name: "search", input: { query: "foo" } }],
  });
  session.addMessage({
    role: "tool",
    toolCallId: "t1",
    toolName: "search",
    content: "a]".repeat(500),
  });
  session.addMessage({ role: "user", content: "thanks" });
  session.addMessage({ role: "assistant", content: "ok" });

  session.trim(50, 2);

  const after = session.getMessages();
  const toolAfter = after.find((m) => m.role === "tool");
  // If the tool message survived trimming, its content should be summarized
  if (toolAfter) {
    assert.ok(
      toolAfter.content.startsWith("[summary:"),
      "tool result should be summarized after trim"
    );
  }
});

