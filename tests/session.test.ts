import { test } from "node:test";
import assert from "node:assert/strict";

import { Session } from "@minicode/agent-sdk";

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

