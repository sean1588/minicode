import path from "node:path";

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmv\b.+\s+\/dev\/null\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fdx?\b/i,
];

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

export function resolveWorkspacePath(
  requestedPath: string,
  workspaceRoot: string,
): string {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const absolutePath = path.resolve(normalizedRoot, requestedPath);

  if (!isWithinWorkspacePath(absolutePath, normalizedRoot)) {
    throw new Error(
      `Path "${requestedPath}" resolves outside workspace root "${normalizedRoot}".`,
    );
  }

  return absolutePath;
}

export function isWithinWorkspacePath(
  absolutePath: string,
  workspaceRoot: string,
): boolean {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const relative = path.relative(normalizedRoot, absolutePath);

  if (relative === "") {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function validatePath(
  requestedPath: string,
  workspaceRoot: string,
): boolean {
  try {
    resolveWorkspacePath(requestedPath, workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

export function validateCommand(command: string, denylist: RegExp[]): void {
  for (const pattern of denylist) {
    if (pattern.test(command)) {
      throw new Error(
        `Command "${command}" blocked by safety denylist (${pattern}).`,
      );
    }
  }
}

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function formatStepLimitMessage(maxSteps: number): string {
  return [
    `Reached the turn call limit (${maxSteps}) for this turn, so I paused here.`,
    'Type "continue" to let me keep working from the current session.',
    'If you want longer turns by default, increase the turn call limit (maxSteps) in Settings or with /config set maxSteps <n>.',
  ].join(" ");
}

export function ensureStepWithinLimit(step: number, maxSteps: number): void {
  if (step >= maxSteps) {
    throw new Error(formatStepLimitMessage(maxSteps));
  }
}

export function validateFileReadSize(
  actualSizeBytes: number,
  maxFileSizeBytes: number,
): void {
  if (actualSizeBytes > maxFileSizeBytes) {
    throw new Error(
      `File too large to read (${actualSizeBytes} bytes). Limit is ${maxFileSizeBytes} bytes.`,
    );
  }
}
