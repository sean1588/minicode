/**
 * Benchmark harness types for measuring agent quality, efficiency,
 * and structural-tool usage across repeatable tasks.
 */

/** Categories of benchmark tasks. */
export type BenchmarkCategory =
  | "navigation"
  | "editing"
  | "refactors"
  | "debugging"
  | "planning";

/** A single benchmark task definition loaded from disk. */
export interface BenchmarkTask {
  /** Unique identifier, e.g. "navigation/find-symbol-definition". */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Category for grouping results. */
  category: BenchmarkCategory;
  /** The prompt sent to the agent. */
  prompt: string;
  /** Optional workspace root override (relative to repo root). Defaults to fixture or repo root. */
  workspaceRoot?: string | undefined;
  /** Rubric for evaluating the result. */
  rubric: BenchmarkRubric;
}

/** Evaluation rubric for a benchmark task. */
export interface BenchmarkRubric {
  /** Keywords or patterns that MUST appear in the agent's final response. */
  expectedOutputPatterns?: string[] | undefined;
  /** Files the agent should have read during the task. */
  expectedFilesRead?: string[] | undefined;
  /** Symbols the agent should have queried via structural tools. */
  expectedSymbols?: string[] | undefined;
  /** If set, the agent's response must NOT match these patterns (negative checks). */
  forbiddenPatterns?: string[] | undefined;
  /** Maximum number of tool calls allowed for an efficiency pass. */
  maxToolCalls?: number | undefined;
  /** Maximum total tokens (input + output) allowed for an efficiency pass. */
  maxTotalTokens?: number | undefined;
  /** Custom evaluator function name (for advanced checks). */
  customEvaluator?: string | undefined;
}

/** A single tool call captured during a benchmark run. */
export interface CapturedToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
}

/** Full trace of a single benchmark run. */
export interface BenchmarkTrace {
  /** Task that was run. */
  taskId: string;
  /** Model used. */
  model: string;
  /** Config variant label (e.g. "baseline", "v2-prompt"). */
  variant: string;
  /** Git commit SHA of the codebase under test. */
  commitSha: string;
  /** Agent's final text response. */
  response: string;
  /** Ordered list of tool calls made during the run. */
  toolCalls: CapturedToolCall[];
  /** Files that were read (extracted from tool calls). */
  filesRead: string[];
  /** Symbols queried via structural tools. */
  symbolsQueried: string[];
  /** Token usage. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Wall-clock duration of the full run in milliseconds. */
  durationMs: number;
  /** Timestamp when the run started. */
  startedAt: string;
}

/** Result of evaluating a single benchmark run against its rubric. */
export interface BenchmarkEvaluation {
  taskId: string;
  /** Overall pass/fail. */
  passed: boolean;
  /** Individual check results. */
  checks: EvaluationCheck[];
  /** Efficiency metrics. */
  efficiency: EfficiencyMetrics;
}

export interface EvaluationCheck {
  name: string;
  passed: boolean;
  detail?: string | undefined;
}

export interface EfficiencyMetrics {
  toolCallCount: number;
  totalTokens: number;
  durationMs: number;
  filesReadCount: number;
  symbolsQueriedCount: number;
  /** Whether the run stayed within the rubric's efficiency bounds. */
  withinBudget: boolean;
}

/** Aggregated results across multiple benchmark runs. */
export interface BenchmarkReport {
  /** Label for this run (e.g. "baseline", "v2-prompt"). */
  variant: string;
  /** Model used. */
  model: string;
  /** When the report was generated. */
  generatedAt: string;
  /** Per-task results. */
  results: BenchmarkResult[];
  /** Aggregate summary. */
  summary: ReportSummary;
}

export interface BenchmarkResult {
  taskId: string;
  category: BenchmarkCategory;
  evaluation: BenchmarkEvaluation;
  trace: BenchmarkTrace;
}

export interface ReportSummary {
  totalTasks: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Breakdown by category. */
  byCategory: Record<
    string,
    { total: number; passed: number; passRate: number }
  >;
  /** Aggregate efficiency. */
  avgToolCalls: number;
  avgTotalTokens: number;
  avgDurationMs: number;
}
