import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { Session } from "@minicode/agent-sdk";

import {
  DuplicateSessionLabelError,
  listSessions,
  loadSession,
  loadSessionByLabel,
  saveSession,
  setSessionsDir,
} from "../src/session/session-store.js";

async function withTmpDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "minicode-test-"));
  setSessionsDir(dir);
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveSession creates a JSON file in sessions dir", async () => {
  await withTmpDir(async (dir) => {
    const session = new Session("test-id");
    session.addMessage({ role: "user", content: "hello" });
    session.addMessage({ role: "assistant", content: "hi there" });

    const meta = await saveSession(session, "my label");

    assert.equal(meta.id, "test-id");
    assert.equal(meta.label, "my label");
    assert.equal(meta.messageCount, 2);

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], "test-id.json");
  });
});

test("saveSession uses timestamp label when none provided", async () => {
  await withTmpDir(async () => {
    const session = new Session("test-id");
    const meta = await saveSession(session);
    assert.ok(meta.label.length > 0);
  });
});

test("listSessions returns empty array when no sessions dir", async () => {
  const nonexistent = path.join(os.tmpdir(), "minicode-nonexistent-" + Date.now());
  setSessionsDir(nonexistent);
  const sessions = await listSessions();
  assert.equal(sessions.length, 0);
});

test("listSessions returns saved sessions sorted by savedAt desc", async () => {
  await withTmpDir(async () => {
    const s1 = new Session("s1");
    s1.addMessage({ role: "user", content: "first" });
    await saveSession(s1, "first session");

    // Small delay to ensure distinct timestamps for ordering
    await new Promise((r) => setTimeout(r, 50));

    const s2 = new Session("s2");
    s2.addMessage({ role: "user", content: "second" });
    s2.addMessage({ role: "assistant", content: "reply" });
    await saveSession(s2, "second session");

    const sessions = await listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.label, "second session");
    assert.equal(sessions[1]?.label, "first session");
  });
});

test("loadSession restores a session by id", async () => {
  await withTmpDir(async () => {
    const session = new Session("test-id");
    session.addMessage({ role: "user", content: "hello" });
    session.addMessage({ role: "assistant", content: "hi" });
    await saveSession(session, "test label");

    const result = await loadSession("test-id");
    assert.ok(result);
    assert.equal(result.label, "test label");
    assert.equal(result.session.id, "test-id");

    const msgs = result.session.getMessages();
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.content, "hello");
    assert.equal(msgs[1]?.content, "hi");
  });
});

test("loadSession returns undefined for missing id", async () => {
  await withTmpDir(async () => {
    const result = await loadSession("nonexistent");
    assert.equal(result, undefined);
  });
});

test("loadSessionByLabel finds session by label (case-insensitive)", async () => {
  await withTmpDir(async () => {
    const session = new Session("test-id");
    session.addMessage({ role: "user", content: "hello" });
    await saveSession(session, "My Label");

    const result = await loadSessionByLabel("my label");
    assert.ok(result);
    assert.equal(result.label, "My Label");
    assert.equal(result.session.id, "test-id");
  });
});

test("loadSessionByLabel returns undefined for no match", async () => {
  await withTmpDir(async () => {
    const result = await loadSessionByLabel("nope");
    assert.equal(result, undefined);
  });
});

test("saveSession rejects duplicate labels for different sessions", async () => {
  await withTmpDir(async (dir) => {
    const firstSession = new Session("first-id");
    firstSession.addMessage({ role: "user", content: "first" });
    await saveSession(firstSession, "My Label");

    const secondSession = new Session("second-id");
    secondSession.addMessage({ role: "user", content: "second" });

    await assert.rejects(
      () => saveSession(secondSession, " my label "),
      (error) =>
        error instanceof DuplicateSessionLabelError &&
        error.label === "my label" &&
        error.existingSessionId === "first-id",
    );

    const files = await readdir(dir);
    assert.deepEqual(files, ["first-id.json"]);
  });
});

test("saving same session twice overwrites the file", async () => {
  await withTmpDir(async (dir) => {
    const session = new Session("test-id");
    session.addMessage({ role: "user", content: "hello" });
    await saveSession(session, "v1");

    session.addMessage({ role: "assistant", content: "reply" });
    await saveSession(session, "v2");

    const files = await readdir(dir);
    assert.equal(files.length, 1);

    const result = await loadSession("test-id");
    assert.ok(result);
    assert.equal(result.label, "v2");
    assert.equal(result.session.getMessages().length, 2);
  });
});
