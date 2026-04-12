import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { MINICODE_HOME } from "./config.js";

export function getHomeEnvPath(minicodeHome = MINICODE_HOME): string {
  return path.join(minicodeHome, ".env");
}

function formatEnvValue(value: string): string {
  return value;
}

export async function upsertHomeEnvValues(options: {
  values: Record<string, string>;
  minicodeHome?: string;
}): Promise<{ path: string; updatedKeys: string[] }> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const envPath = getHomeEnvPath(minicodeHome);

  await mkdir(path.dirname(envPath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch {
    existing = "";
  }

  const pending = new Map(Object.entries(options.values));
  const managedKeys = new Set(pending.keys());
  const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const normalizedLines = existing === ""
    ? []
    : existing.split(/\r?\n/);
  const nextLines: string[] = [];
  const seen = new Set<string>();

  for (const line of normalizedLines) {
    const match = line.match(assignmentPattern);
    if (!match) {
      nextLines.push(line);
      continue;
    }

    const key = match[1]!;
    if (!managedKeys.has(key)) {
      nextLines.push(line);
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    nextLines.push(`${key}=${formatEnvValue(pending.get(key)!)}`);
    seen.add(key);
    pending.delete(key);
  }

  if (pending.size > 0 && nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  const fileContent = `${nextLines.join("\n").replace(/\n+$/, "")}\n`;
  await writeFile(envPath, fileContent, "utf8");

  return {
    path: envPath,
    updatedKeys: Object.keys(options.values),
  };
}
