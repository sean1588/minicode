import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

function getSessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".minicode", "sessions");
}

export async function saveSession(
  session: Session,
  workspaceRoot: string,
  label?: string,
): Promise<SavedSessionMeta> {
  const dir = getSessionsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });

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

  const filePath = path.join(dir, `${snapshot.id}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");

  return {
    id: snapshot.id,
    label: resolvedLabel,
    createdAt: snapshot.createdAt,
    savedAt,
    messageCount: snapshot.messages.length,
  };
}

export async function listSessions(
  workspaceRoot: string,
): Promise<SavedSessionMeta[]> {
  const dir = getSessionsDir(workspaceRoot);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const results: SavedSessionMeta[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, file), "utf8");
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
  workspaceRoot: string,
  sessionId: string,
): Promise<{ session: Session; label: string } | undefined> {
  const dir = getSessionsDir(workspaceRoot);
  const filePath = path.join(dir, `${sessionId}.json`);
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
  workspaceRoot: string,
  label: string,
): Promise<{ session: Session; label: string } | undefined> {
  const sessions = await listSessions(workspaceRoot);
  const match = sessions.find(
    (s) => s.label.toLowerCase() === label.toLowerCase(),
  );
  if (!match) return undefined;
  return loadSession(workspaceRoot, match.id);
}
