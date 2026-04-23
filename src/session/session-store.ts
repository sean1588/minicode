import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Session, type SessionSnapshot } from "@minicode/agent-sdk";

export interface SavedSessionMeta {
  id: string;
  label: string;
  createdAt: string;
  savedAt: string;
  messageCount: number;
}

interface SavedSessionFile {
  label: string;
  savedAt: string;
  session: SessionSnapshot;
  annotations?: Record<string, string[]>;
}

let sessionsDir = path.join(os.homedir(), ".minicode", "sessions");

export class DuplicateSessionLabelError extends Error {
  constructor(
    readonly label: string,
    readonly existingSessionId: string,
  ) {
    super(`A saved session named "${label}" already exists. Choose a different name or load that session to update it.`);
    this.name = "DuplicateSessionLabelError";
  }
}

/** Override sessions directory (for testing). */
export function setSessionsDir(dir: string): void {
  sessionsDir = dir;
}

function normalizeSessionLabel(label: string): string {
  return label.trim().toLowerCase();
}

export async function saveSession(
  session: Session,
  label?: string,
  annotations?: Record<string, string[]>,
): Promise<SavedSessionMeta> {
  await mkdir(sessionsDir, { recursive: true });

  const savedAt = new Date().toISOString();
  const snapshot = session.toJSON();
  const resolvedLabel =
    label && label.trim().length > 0
      ? label.trim()
      : new Date().toLocaleString();

  const duplicate = (await listSessions()).find(
    (savedSession) =>
      savedSession.id !== snapshot.id &&
      normalizeSessionLabel(savedSession.label) === normalizeSessionLabel(resolvedLabel),
  );
  if (duplicate) {
    throw new DuplicateSessionLabelError(resolvedLabel, duplicate.id);
  }

  const data: SavedSessionFile = {
    label: resolvedLabel,
    savedAt,
    session: snapshot,
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };

  const filePath = path.join(sessionsDir, `${snapshot.id}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");

  return {
    id: snapshot.id,
    label: resolvedLabel,
    createdAt: snapshot.createdAt,
    savedAt,
    messageCount: snapshot.messages.length,
  };
}

export async function listSessions(): Promise<SavedSessionMeta[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const results: SavedSessionMeta[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(sessionsDir, file), "utf8");
      const data = JSON.parse(raw) as SavedSessionFile;
      results.push({
        id: data.session.id,
        label: data.label,
        createdAt: data.session.createdAt,
        savedAt: data.savedAt,
        messageCount: data.session.messages.length,
      });
    } catch {
      // skip corrupt files
    }
  }

  results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return results;
}

export async function loadSession(
  sessionId: string,
): Promise<{ session: Session; label: string; annotations?: Record<string, string[]> } | undefined> {
  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as SavedSessionFile;
    return {
      session: Session.fromJSON(data.session),
      label: data.label,
      ...(data.annotations ? { annotations: data.annotations } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function loadSessionByLabel(
  label: string,
): Promise<{ session: Session; label: string; annotations?: Record<string, string[]> } | undefined> {
  const sessions = await listSessions();
  const match = sessions.find(
    (s) => s.label.toLowerCase() === label.toLowerCase(),
  );
  if (!match) return undefined;
  return loadSession(match.id);
}
