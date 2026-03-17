import { test } from "node:test";
import assert from "node:assert/strict";

import { Session } from "../src/session/session.js";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolSchema,
} from "../src/agent/types.js";

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

test("toJSON returns a serializable snapshot", () => {
  const session = new Session("snap-id");
  session.addMessage({ role: "user", content: "hello" });
  session.addMessage({ role: "assistant", content: "world" });

  const snapshot = session.toJSON();
  assert.equal(snapshot.id, "snap-id");
  assert.equal(typeof snapshot.createdAt, "string");
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[0]?.content, "hello");
  const parsed = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(parsed, snapshot);
});

test("fromJSON restores a session from a snapshot", () => {
  const original = new Session("restore-id");
  original.addMessage({ role: "user", content: "question" });
  original.addMessage({
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "t1", name: "read_file", input: { path: "x.ts" } }],
  });
  original.addMessage({
    role: "tool",
    toolCallId: "t1",
    toolName: "read_file",
    content: "file contents",
  });

  const snapshot = original.toJSON();
  const restored = Session.fromJSON(snapshot);

  assert.equal(restored.id, "restore-id");
  assert.equal(restored.createdAt.toISOString(), original.createdAt.toISOString());
  assert.deepEqual(restored.getMessages(), original.getMessages());
});

test("fromJSON roundtrips through JSON.stringify/parse", () => {
  const session = new Session("rt-id");
  session.addMessage({ role: "user", content: "test" });

  const json = JSON.stringify(session.toJSON());
  const restored = Session.fromJSON(JSON.parse(json));

  assert.equal(restored.id, "rt-id");
  assert.equal(restored.getMessages().length, 1);
  assert.equal(restored.getMessages()[0]?.content, "test");
});

// --- LLM-based compaction tests ---

class FakeModelClient implements ModelClient {
  readonly lastMessages: SessionMessage[][] = [];
  responseText: string;

  constructor(responseText = "Summary: user asked to fix a bug in app.ts") {
    this.responseText = responseText;
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    this.lastMessages.push([...params.messages]);
    return {
      text: this.responseText,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

test("compactWithLlm uses LLM summary and preserves recent messages", async () => {
  const session = new Session("llm-compact");
  session.addMessage({ role: "user", content: "fix the bug in app.ts" });
  session.addMessage({ role: "assistant", content: "I will read the file" });
  session.addMessage({
    role: "assistant",
    content: "reading",
    toolCalls: [{ id: "t1", name: "read_file", input: { path: "app.ts" } }],
  });
  session.addMessage({
    role: "tool",
    toolCallId: "t1",
    toolName: "read_file",
    content: "const x = 1;\nconst y = 2;",
  });
  session.addMessage({ role: "assistant", content: "I found the issue" });
  session.addMessage({ role: "user", content: "great, fix it" });

  const client = new FakeModelClient();
  const result = await session.compactWithLlm(2, client, "test-haiku");

  assert.ok(result);
  assert.equal(result.removedMessages, 4);

  const messages = session.getMessages();
  // Summary + 2 preserved recent messages
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, "user");
  assert.ok(messages[0]?.content.includes("LLM summarization"));
  assert.ok(messages[0]?.content.includes("Summary: user asked to fix a bug"));
  // Recent messages preserved
  assert.equal(messages[1]?.content, "I found the issue");
  assert.equal(messages[2]?.content, "great, fix it");
});

test("compactWithLlm returns null when nothing to compact", async () => {
  const session = new Session("llm-empty");
  session.addMessage({ role: "user", content: "hello" });

  const client = new FakeModelClient();
  const result = await session.compactWithLlm(5, client, "test-haiku");

  assert.equal(result, null);
  assert.equal(client.lastMessages.length, 0); // LLM should not be called
});

test("compactWithLlm falls back to mechanical compaction on error", async () => {
  const session = new Session("llm-fallback");
  session.addMessage({ role: "user", content: "first message" });
  session.addMessage({ role: "assistant", content: "first response" });
  session.addMessage({ role: "user", content: "second message" });
  session.addMessage({ role: "assistant", content: "second response" });

  const failingClient: ModelClient = {
    async chat() {
      throw new Error("API unavailable");
    },
  };

  const result = await session.compactWithLlm(2, failingClient, "test-haiku");

  assert.ok(result);
  const messages = session.getMessages();
  // Should fall back to mechanical compaction
  assert.equal(messages[0]?.role, "user");
  assert.ok(messages[0]?.content.includes("Conversation Summary"));
  assert.ok(!messages[0]?.content.includes("LLM summarization"));
});
