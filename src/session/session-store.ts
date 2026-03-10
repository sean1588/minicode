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
}

let sessionsDir = path.join(os.homedir(), ".minicode", "sessions");

/** Override sessions directory (for testing). */
export function setSessionsDir(dir: string): void {
  sessionsDir = dir;
}

export async function saveSession(
  session: Session,
  label?: string,
): Promise<SavedSessionMeta> {
  await mkdir(sessionsDir, { recursive: true });

  const savedAt = new Date().toISOString();
  const snapshot = session.toJSON();
  const resolvedLabel =
    label && label.trim().length > 0
      ? label.trim()
      : new Date().toLocaleString();

  const data: SavedSessionFile = {
    label: resolvedLabel,
    savedAt,
    session: snapshot,
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
): Promise<{ session: Session; label: string } | undefined> {
  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as SavedSessionFile;
    return {
      session: Session.fromJSON(data.session),
      label: data.label,
    };
  } catch {
    return undefined;
  }
}

export async function loadSessionByLabel(
  label: string,
): Promise<{ session: Session; label: string } | undefined> {
  const sessions = await listSessions();
  const match = sessions.find(
    (s) => s.label.toLowerCase() === label.toLowerCase(),
  );
  if (!match) return undefined;
  return loadSession(match.id);
}
