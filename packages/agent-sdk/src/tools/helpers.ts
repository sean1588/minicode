export function expectNonEmptyString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Input "${key}" must be a non-empty string.`);
  }
  return value;
}

export function expectOptionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Input "${key}" must be a boolean when provided.`);
  }
  return value;
}

export function expectOptionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Input "${key}" must be a finite number when provided.`);
  }
  return value;
}

export function formatWithLineNumbers(
  text: string,
  startLine = 1,
  limit?: number,
): string {
  const lines = text.split(/\r?\n/);
  const beginIndex = Math.max(startLine - 1, 0);
  const endIndex =
    limit === undefined
      ? lines.length
      : Math.min(lines.length, beginIndex + Math.max(limit, 0));

  const output: string[] = [];
  for (let index = beginIndex; index < endIndex; index += 1) {
    output.push(`${index + 1}|${lines[index] ?? ""}`);
  }
  return output.join("\n");
}

export function toJson(input: unknown): string {
  return JSON.stringify(input);
}
