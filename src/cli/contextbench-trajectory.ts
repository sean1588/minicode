import type { IndexedSymbol } from "@sean.holung/minicode-sdk";

import type { buildProjectIndex } from "../indexer/project-index.js";

import type { BenchmarkToolCallTrace } from "./benchmark-run.js";

type IndexInstance = Awaited<ReturnType<typeof buildProjectIndex>>;

export interface ContextBenchTrajectoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContextBenchTrajectory {
  messages: ContextBenchTrajectoryMessage[];
  info: {
    submission: string;
    config?: { environment?: { image?: string } };
  };
}

export interface FileSpan {
  file: string;
  startLine: number;
  endLine: number;
}

export interface BuildTrajectoryOptions {
  systemPrompt: string;
  userPrompt: string;
  toolCalls: BenchmarkToolCallTrace[];
  finalAssistantText: string;
  workspaceRoot: string;
  patch: string;
  projectIndex?: IndexInstance;
  /** Docker image used for the run. Surfaced in info.config.environment.image for the MiniSWE
   *  extractor's `repo_dir_name` heuristic. */
  image?: string;
}

/**
 * Convert a benchmark run into a MiniSWE-Agent compatible `.traj.json` trajectory
 * that ContextBench's existing extractor (`contextbench/agents/minisweagent/extract.py`)
 * can parse via the preferred `<explore_context>` / `<PATCH_CONTEXT>` path.
 *
 * Each tool call is rendered into one assistant message whose body contains a
 * single `<explore_context>` block enumerating the files and line ranges the
 * agent looked at on that step. The final assistant message carries a
 * `<PATCH_CONTEXT>` block computed from the unified diff, listing the files
 * and hunk ranges the agent actually edited.
 */
export function buildContextBenchTrajectory(
  options: BuildTrajectoryOptions,
): ContextBenchTrajectory {
  const messages: ContextBenchTrajectoryMessage[] = [];
  messages.push({ role: "system", content: options.systemPrompt });
  messages.push({ role: "user", content: options.userPrompt });

  // Group tool calls by step so that batched calls within one assistant turn
  // produce a single assistant message — mirrors how a real agent transcript
  // is structured.
  const stepGroups = new Map<number, BenchmarkToolCallTrace[]>();
  for (const call of options.toolCalls) {
    const list = stepGroups.get(call.step);
    if (list) list.push(call);
    else stepGroups.set(call.step, [call]);
  }

  const sortedSteps = [...stepGroups.keys()].sort((a, b) => a - b);
  for (const step of sortedSteps) {
    const calls = stepGroups.get(step)!;
    const spans = collectSpansForCalls(calls, options.projectIndex);
    if (spans.length === 0) continue;
    messages.push({
      role: "assistant",
      content: `<explore_context>\n${formatSpans(spans)}\n</explore_context>`,
    });
  }

  const patchSpans = parsePatchSpans(options.patch);
  const patchBlock =
    patchSpans.length > 0
      ? `<PATCH_CONTEXT>\n${formatSpans(patchSpans)}\n</PATCH_CONTEXT>`
      : "<PATCH_CONTEXT>\n</PATCH_CONTEXT>";
  const finalText = options.finalAssistantText.trim();
  messages.push({
    role: "assistant",
    content: finalText.length > 0 ? `${finalText}\n\n${patchBlock}` : patchBlock,
  });

  return {
    messages,
    info: {
      submission: options.patch,
      ...(options.image
        ? { config: { environment: { image: options.image } } }
        : {}),
    },
  };
}

function formatSpans(spans: FileSpan[]): string {
  // Stable ordering by file, then start line.
  const sorted = [...spans].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.endLine - b.endLine,
  );
  return sorted
    .map((s) => `File: ${s.file}\nLines: ${s.startLine}-${s.endLine}`)
    .join("\n");
}

function collectSpansForCalls(
  calls: BenchmarkToolCallTrace[],
  index: IndexInstance | undefined,
): FileSpan[] {
  const collected: FileSpan[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.skipped) continue;
    for (const span of spansForCall(call, index)) {
      const key = `${span.file}:${span.startLine}-${span.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(span);
    }
  }
  return collected;
}

function spansForCall(
  call: BenchmarkToolCallTrace,
  index: IndexInstance | undefined,
): FileSpan[] {
  switch (call.name) {
    case "read_file":
      return spansForReadFile(call);
    case "read_symbol":
      return spansForSymbolLookup(call, index);
    case "find_references":
      return spansForReferences(call, index);
    case "get_dependencies":
      return spansForDependencyCone(call, index);
    case "edit_file":
    case "write_file":
      return spansForMutation(call);
    default:
      return [];
  }
}

function spansForReadFile(call: BenchmarkToolCallTrace): FileSpan[] {
  const filePath = stringField(call.input, "path");
  if (!filePath) return [];

  const offset = numberField(call.input, "offset");
  const limit = numberField(call.input, "limit");
  const start = offset !== undefined && offset > 0 ? offset : 1;

  // Prefer the tool result's last line-number prefix as a tight upper bound,
  // since read_file emits `<line>|<content>` per line. Fall back to
  // offset+limit-1 when no offset/limit is known.
  const resultEndLine = lastLineNumberInResult(call.result);
  let end: number;
  if (resultEndLine !== undefined) {
    end = resultEndLine;
  } else if (limit !== undefined && limit > 0) {
    end = start + limit - 1;
  } else {
    // Read with no offset/limit and unparseable result — we can't infer a
    // useful end line, so skip this span rather than fabricate one.
    return [];
  }
  if (end < start) end = start;
  return [{ file: filePath, startLine: start, endLine: end }];
}

function spansForSymbolLookup(
  call: BenchmarkToolCallTrace,
  index: IndexInstance | undefined,
): FileSpan[] {
  if (!index) return [];
  const name = stringField(call.input, "name");
  if (!name) return [];
  // Some symbols resolve to multiple candidates (e.g. method `foo` on
  // multiple classes). Emit a span per match so coverage credit reflects
  // what the agent actually paid attention to.
  const matches = index.getSymbolMatches?.(name) ?? [];
  const candidates: IndexedSymbol[] =
    matches.length > 0 ? matches : ((index.getSymbol?.(name) ? [index.getSymbol!(name)!] : []) as IndexedSymbol[]);
  return candidates.map(indexedSymbolToFileSpan).filter(isDefined);
}

function spansForReferences(
  call: BenchmarkToolCallTrace,
  index: IndexInstance | undefined,
): FileSpan[] {
  if (!index) return [];
  const name = stringField(call.input, "name");
  if (!name) return [];
  const edges = index.dependencyEdges ?? [];
  const target = index.getSymbol?.(name);
  if (!target) return [];
  const incoming = edges.filter((e) => e.to === target.qualifiedName);
  const spans: FileSpan[] = [];
  for (const edge of incoming) {
    const sym = index.getSymbol?.(edge.from);
    const span = sym ? indexedSymbolToFileSpan(sym) : undefined;
    if (span) spans.push(span);
  }
  return spans;
}

function spansForDependencyCone(
  call: BenchmarkToolCallTrace,
  index: IndexInstance | undefined,
): FileSpan[] {
  if (!index?.getDependencyCone) return [];
  const name = stringField(call.input, "name") ?? stringField(call.input, "symbol");
  if (!name) return [];
  const depth = numberField(call.input, "depth") ?? 2;
  const cone = index.getDependencyCone(name, depth);
  return cone.map(indexedSymbolToFileSpan).filter(isDefined);
}

function spansForMutation(call: BenchmarkToolCallTrace): FileSpan[] {
  // Mutations don't broaden the *exploration* set on their own — the final
  // PATCH_CONTEXT covers what was changed. But ContextBench's gold-context
  // includes edit-location credit, so emitting a span for the touched file
  // helps make sure edits show up in the explored-set too. We don't have
  // exact line ranges here without re-reading, so fall back to a single-line
  // span at the explicit `offset`/`line` field when present; otherwise skip.
  const filePath = stringField(call.input, "path");
  if (!filePath) return [];
  const offset = numberField(call.input, "offset");
  if (offset !== undefined && offset > 0) {
    return [{ file: filePath, startLine: offset, endLine: offset }];
  }
  return [];
}

function indexedSymbolToFileSpan(symbol: IndexedSymbol): FileSpan {
  return {
    file: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function stringField(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function lastLineNumberInResult(result: string | null): number | undefined {
  if (!result) return undefined;
  const trimmed = result.replace(/\s+$/, "");
  if (trimmed.length === 0) return undefined;
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastLine = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed;
  const match = lastLine.match(/^\s*(\d+)\|/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a unified diff into a list of (file, new-file-line-range) spans.
 * Uses the NEW file side (`+` ranges) since that's where the agent's edits
 * landed.
 */
export function parsePatchSpans(patch: string): FileSpan[] {
  if (!patch || patch.trim().length === 0) return [];
  const spans: FileSpan[] = [];
  let currentFile = "";
  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      currentFile = stripDiffPathPrefix(target);
      continue;
    }
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && currentFile) {
      const start = Number(hunk[1]);
      const count = hunk[2] !== undefined ? Number(hunk[2]) : 1;
      const end = count === 0 ? start : start + count - 1;
      spans.push({ file: currentFile, startLine: start, endLine: end });
    }
  }
  return spans;
}

function stripDiffPathPrefix(target: string): string {
  if (target === "/dev/null") return "";
  if (target.startsWith("b/")) return target.slice(2);
  if (target.startsWith("a/")) return target.slice(2);
  return target;
}
