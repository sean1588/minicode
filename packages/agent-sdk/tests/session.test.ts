import { test } from "node:test";
import assert from "node:assert/strict";

import { Session } from "../src/session/session.js";

test("session stores and returns messages", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "hello" });
  session.addMessage({ role: "assistant", content: "world" });

  const messages = session.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
});

test("session getMessages returns a copy", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "hello" });

  const messages1 = session.getMessages();
  const messages2 = session.getMessages();
  assert.notEqual(messages1, messages2);
  assert.deepEqual(messages1, messages2);
});

test("session generates unique id if not provided", () => {
  const session1 = new Session();
  const session2 = new Session();
  assert.notEqual(session1.id, session2.id);
  assert.ok(session1.id.length > 0);
});

test("session uses provided id", () => {
  const session = new Session("my-session");
  assert.equal(session.id, "my-session");
});

test("session tracks token estimate", () => {
  const session = new Session("test");
  assert.equal(session.getTokenEstimate(), 0);

  session.addMessage({ role: "user", content: "a".repeat(100) });
  assert.equal(session.getTokenEstimate(), 25); // 100 / 4
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

test("trim does nothing when within budget", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "short" });
  session.addMessage({ role: "assistant", content: "reply" });

  session.trim(100_000, 10);
  assert.equal(session.getMessages().length, 2);
});

test("trim does nothing when keepRecentMessages is negative", () => {
  const session = new Session("test");
  session.addMessage({ role: "user", content: "a".repeat(1000) });
  session.addMessage({ role: "assistant", content: "b".repeat(1000) });

  session.trim(1, -1);
  assert.equal(session.getMessages().length, 2);
});
