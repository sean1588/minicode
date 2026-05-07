import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolDefinition,
  ToolSchema,
} from "@sean.holung/minicode-sdk";

import { loadBenchmarkTasks, loadBenchmarkTask } from "../src/benchmark/task-loader.js";
import { evaluate } from "../src/benchmark/evaluator.js";
import { runBenchmarkTask } from "../src/benchmark/runner.js";
import {
  buildReport,
  formatReport,
  compareReports,
} from "../src/benchmark/reporter.js";
import type {
  BenchmarkRubric,
  BenchmarkTask,
  BenchmarkTrace,
} from "../src/benchmark/types.js";
import { createTestAgentConfig } from "./test-utils.js";

// ─── Helpers ───────────────────────────────────────────────────

async function createTempTaskDir(): Promise<string> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-test-"));
  await mkdir(path.join(tmpDir, "navigation", "find-foo"), { recursive: true });
  await mkdir(path.join(tmpDir, "editing", "fix-bar"), { recursive: true });

  await writeFile(
    path.join(tmpDir, "navigation", "find-foo", "task.json"),
    JSON.stringify({
      title: "Find foo",
      prompt: "Find where foo is defined",
      rubric: {
        expectedOutputPatterns: ["foo"],
        maxToolCalls: 5,
      },
    }),
  );

  await writeFile(
    path.join(tmpDir, "editing", "fix-bar", "task.json"),
    JSON.stringify({
      title: "Fix bar",
      prompt: "Fix the bar function",
      rubric: {
        expectedOutputPatterns: ["bar"],
        expectedFilesRead: ["bar.ts"],
        forbiddenPatterns: ["error"],
        maxToolCalls: 10,
        maxTotalTokens: 5000,
      },
    }),
  );

  return tmpDir;
}

function makeTrace(overrides: Partial<BenchmarkTrace> = {}): BenchmarkTrace {
  return {
    taskId: "navigation/find-foo",
    model: "test-model",
    variant: "baseline",
    commitSha: "abc123",
    sourceWorkspaceRoot: "/workspace/source",
    workspaceRoot: "/tmp/minicode-benchmark/task",
    response: "Found foo in src/foo.ts at line 10.",
    toolCalls: [
      { name: "search", input: { query: "foo" }, output: "src/foo.ts:10", durationMs: 50 },
      { name: "read_file", input: { path: "src/foo.ts" }, output: "function foo() {}", durationMs: 30 },
    ],
    filesRead: ["src/foo.ts"],
    symbolsQueried: [],
    usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
    durationMs: 200,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

class MockModelClient implements ModelClient {
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    void params;
    return {
      text: this.response,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

class ToolCallingMockClient implements ModelClient {
  private callCount = 0;

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    void params;
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        text: "Let me search for that.",
        toolCalls: [{ id: "t1", name: "echo_tool", input: { value: "hello" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }
    return {
      text: "Found: echo:hello",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };
  }
}

// ─── Task Loader Tests ─────────────────────────────────────────

test("loadBenchmarkTasks loads tasks from directory structure", async () => {
  const tmpDir = await createTempTaskDir();
  try {
    const tasks = await loadBenchmarkTasks(tmpDir);
    assert.equal(tasks.length, 2);
    const first = tasks[0]!;
    const second = tasks[1]!;
    assert.equal(first.id, "editing/fix-bar");
    assert.equal(second.id, "navigation/find-foo");
    assert.equal(first.category, "editing");
    assert.equal(second.category, "navigation");
    assert.equal(second.prompt, "Find where foo is defined");
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

test("loadBenchmarkTasks returns empty array for empty directory", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-empty-"));
  try {
    const tasks = await loadBenchmarkTasks(tmpDir);
    assert.equal(tasks.length, 0);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

test("loadBenchmarkTasks ignores invalid category directories", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-invalid-"));
  await mkdir(path.join(tmpDir, "invalid-category", "task1"), { recursive: true });
  await writeFile(
    path.join(tmpDir, "invalid-category", "task1", "task.json"),
    JSON.stringify({ title: "X", prompt: "X", rubric: {} }),
  );
  try {
    const tasks = await loadBenchmarkTasks(tmpDir);
    assert.equal(tasks.length, 0);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

test("loadBenchmarkTask loads a single task by id", async () => {
  const tmpDir = await createTempTaskDir();
  try {
    const task = await loadBenchmarkTask(tmpDir, "navigation/find-foo");
    assert.ok(task);
    assert.equal(task.title, "Find foo");
    assert.equal(task.category, "navigation");
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

test("loadBenchmarkTask preserves workspaceRoot when provided", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bench-workspace-root-"));
  await mkdir(path.join(tmpDir, "navigation", "fixture-task"), { recursive: true });
  await writeFile(
    path.join(tmpDir, "navigation", "fixture-task", "task.json"),
    JSON.stringify({
      title: "Fixture task",
      prompt: "Use a fixture workspace",
      workspaceRoot: "test-programs/benchmark-index",
      rubric: {},
    }),
  );

  try {
    const task = await loadBenchmarkTask(tmpDir, "navigation/fixture-task");
    assert.ok(task);
    assert.equal(task.workspaceRoot, "test-programs/benchmark-index");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadBenchmarkTask returns undefined for missing task", async () => {
  const tmpDir = await createTempTaskDir();
  try {
    const task = await loadBenchmarkTask(tmpDir, "navigation/nonexistent");
    assert.equal(task, undefined);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

// ─── Evaluator Tests ───────────────────────────────────────────

test("evaluate passes when all expected patterns match", () => {
  const rubric: BenchmarkRubric = {
    expectedOutputPatterns: ["foo", "line \\d+"],
  };
  const trace = makeTrace({ response: "Found foo at line 10" });
  const result = evaluate("test/task", rubric, trace);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks.every((c) => c.passed));
});

test("evaluate fails when expected pattern is missing", () => {
  const rubric: BenchmarkRubric = {
    expectedOutputPatterns: ["bar"],
  };
  const trace = makeTrace({ response: "Found foo at line 10" });
  const result = evaluate("test/task", rubric, trace);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.passed, false);
  assert.ok(result.checks[0]!.detail?.includes("Pattern not found"));
});

test("evaluate checks expected files read", () => {
  const rubric: BenchmarkRubric = {
    expectedFilesRead: ["src/foo.ts", "src/bar.ts"],
  };
  const trace = makeTrace({ filesRead: ["src/foo.ts"] });
  const result = evaluate("test/task", rubric, trace);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.passed, true);
  assert.equal(result.checks[1]!.passed, false);
});

test("evaluate checks expected symbols queried", () => {
  const rubric: BenchmarkRubric = {
    expectedSymbols: ["buildProjectIndex"],
  };
  const trace = makeTrace({ symbolsQueried: ["buildProjectIndex"] });
  const result = evaluate("test/task", rubric, trace);
  assert.equal(result.passed, true);
});

test("evaluate checks forbidden patterns", () => {
  const rubric: BenchmarkRubric = {
    forbiddenPatterns: ["error"],
  };
  const traceOk = makeTrace({ response: "All good" });
  const traceBad = makeTrace({ response: "There was an error" });

  assert.equal(evaluate("t", rubric, traceOk).passed, true);
  assert.equal(evaluate("t", rubric, traceBad).passed, false);
});

test("evaluate computes efficiency metrics", () => {
  const rubric: BenchmarkRubric = {
    maxToolCalls: 3,
    maxTotalTokens: 1000,
  };
  const trace = makeTrace({
    toolCalls: [
      { name: "a", input: {}, output: "", durationMs: 10 },
      { name: "b", input: {}, output: "", durationMs: 10 },
    ],
    usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
  });
  const result = evaluate("t", rubric, trace);
  assert.equal(result.efficiency.toolCallCount, 2);
  assert.equal(result.efficiency.totalTokens, 600);
  assert.equal(result.efficiency.withinBudget, true);
});

test("evaluate marks over-budget when tool calls exceed limit", () => {
  const rubric: BenchmarkRubric = { maxToolCalls: 1 };
  const trace = makeTrace({
    toolCalls: [
      { name: "a", input: {}, output: "", durationMs: 10 },
      { name: "b", input: {}, output: "", durationMs: 10 },
    ],
  });
  const result = evaluate("t", rubric, trace);
  assert.equal(result.efficiency.withinBudget, false);
});

test("evaluate marks over-budget when tokens exceed limit", () => {
  const rubric: BenchmarkRubric = { maxTotalTokens: 100 };
  const trace = makeTrace({
    usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
  });
  const result = evaluate("t", rubric, trace);
  assert.equal(result.efficiency.withinBudget, false);
});

test("evaluate passes with empty rubric", () => {
  const rubric: BenchmarkRubric = {};
  const trace = makeTrace();
  const result = evaluate("t", rubric, trace);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 0);
  assert.equal(result.efficiency.withinBudget, true);
});

// ─── Runner Tests ──────────────────────────────────────────────

test("runBenchmarkTask captures trace with tool calls", async () => {
  const task: BenchmarkTask = {
    id: "navigation/test-task",
    title: "Test task",
    category: "navigation",
    prompt: "Find the thing",
    rubric: {},
  };

  const echoTool: ToolDefinition = {
    name: "echo_tool",
    description: "Echoes a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute: async (input) => `echo:${String(input.value)}`,
  };

  const config = createTestAgentConfig(process.cwd());
  const trace = await runBenchmarkTask(task, {
    modelClient: new ToolCallingMockClient(),
    config,
    tools: [echoTool],
    variant: "test",
  });

  assert.equal(trace.taskId, "navigation/test-task");
  assert.equal(trace.variant, "test");
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0]!.name, "echo_tool");
  assert.equal(trace.toolCalls[0]!.output, "echo:hello");
  assert.ok(trace.durationMs >= 0);
  assert.ok(trace.usage.totalTokens > 0);
});

test("runBenchmarkTask captures trace without tool calls", async () => {
  const task: BenchmarkTask = {
    id: "planning/simple",
    title: "Simple task",
    category: "planning",
    prompt: "Explain something",
    rubric: {},
  };

  const config = createTestAgentConfig(process.cwd());
  const trace = await runBenchmarkTask(task, {
    modelClient: new MockModelClient("Here is my explanation about foo."),
    config,
    tools: [],
    variant: "baseline",
  });

  assert.equal(trace.response, "Here is my explanation about foo.");
  assert.equal(trace.toolCalls.length, 0);
  assert.equal(trace.variant, "baseline");
});

test("runBenchmarkTask calls onTaskComplete callback", async () => {
  const task: BenchmarkTask = {
    id: "nav/cb-test",
    title: "Callback test",
    category: "navigation",
    prompt: "Do something",
    rubric: {},
  };

  let callbackTaskId: string | undefined;
  const config = createTestAgentConfig(process.cwd());
  await runBenchmarkTask(task, {
    modelClient: new MockModelClient("done"),
    config,
    tools: [],
    variant: "v1",
    onTaskComplete: (taskId) => {
      callbackTaskId = taskId;
    },
  });

  assert.equal(callbackTaskId, "nav/cb-test");
});

test("runBenchmarkTask tracks files read from read_file tool", async () => {
  const task: BenchmarkTask = {
    id: "nav/file-track",
    title: "File tracking test",
    category: "navigation",
    prompt: "Read a file",
    rubric: {},
  };

  let callCount = 0;
  const mockClient: ModelClient = {
    async chat(params) {
      void params;
      callCount += 1;
      if (callCount === 1) {
        return {
          text: "Reading file",
          toolCalls: [{ id: "t1", name: "read_file", input: { path: "src/main.ts" } }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        text: "Found it",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };

  const readFileTool: ToolDefinition = {
    name: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => "file contents here",
  };

  const config = createTestAgentConfig(process.cwd());
  const trace = await runBenchmarkTask(task, {
    modelClient: mockClient,
    config,
    tools: [readFileTool],
    variant: "v1",
  });

  assert.ok(trace.filesRead.includes("src/main.ts"));
});

test("runBenchmarkTask tracks symbols from structural tools", async () => {
  const task: BenchmarkTask = {
    id: "nav/sym-track",
    title: "Symbol tracking test",
    category: "navigation",
    prompt: "Find references",
    rubric: {},
  };

  let callCount = 0;
  const mockClient: ModelClient = {
    async chat(params) {
      void params;
      callCount += 1;
      if (callCount === 1) {
        return {
          text: "Looking up symbol",
          toolCalls: [{ id: "t1", name: "read_symbol", input: { symbol: "CodingAgent" } }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        text: "Found CodingAgent",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };

  const readSymbolTool: ToolDefinition = {
    name: "read_symbol",
    description: "Read a symbol",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    execute: async () => "class CodingAgent { ... }",
  };

  const config = createTestAgentConfig(process.cwd());
  const trace = await runBenchmarkTask(task, {
    modelClient: mockClient,
    config,
    tools: [readSymbolTool],
    variant: "v1",
  });

  assert.ok(trace.symbolsQueried.includes("CodingAgent"));
});

test("runBenchmarkTask resolves task workspace overrides and isolates the run", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "bench-repo-root-"));
  const sourceWorkspace = path.join(repoRoot, "fixtures", "sample-project");
  await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const answer = 42;\n");

  const task: BenchmarkTask = {
    id: "navigation/workspace-root",
    title: "Workspace root test",
    category: "navigation",
    prompt: "Inspect the fixture workspace",
    workspaceRoot: "fixtures/sample-project",
    rubric: {},
  };

  try {
    const config = createTestAgentConfig(repoRoot);
    const trace = await runBenchmarkTask(task, {
      modelClient: new MockModelClient("done"),
      config,
      tools: [],
      variant: "test",
      repoRoot,
    });

    assert.equal(trace.sourceWorkspaceRoot, sourceWorkspace);
    assert.notEqual(trace.workspaceRoot, sourceWorkspace);
    assert.ok(trace.workspaceRoot.includes("minicode-benchmark-"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("runBenchmarkTask uses project index metadata to count read_symbol as a file read", async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const task: BenchmarkTask = {
    id: "navigation/structural-file-tracking",
    title: "Structural file tracking",
    category: "navigation",
    prompt: "Read the CodingAgent symbol",
    rubric: {},
  };

  let callCount = 0;
  const mockClient: ModelClient = {
    async chat(params) {
      void params;
      callCount += 1;
      if (callCount === 1) {
        return {
          text: "Looking up symbol",
          toolCalls: [{ id: "t1", name: "read_symbol", input: { name: "CodingAgent" } }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        text: "Found CodingAgent",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };

  const config = createTestAgentConfig(workspaceRoot);
  const trace = await runBenchmarkTask(task, {
    modelClient: mockClient,
    config,
    variant: "v1",
    isolateWorkspace: false,
    createToolset: async (taskConfig) => {
      const { buildProjectIndex } = await import("../src/indexer/project-index.js");
      const { createToolRegistry } = await import("../src/tools/registry.js");
      const projectIndex = await buildProjectIndex(taskConfig.workspaceRoot);
      const toolRegistry = createToolRegistry(taskConfig, projectIndex);
      return {
        tools: toolRegistry.getDefinitions(),
        projectIndex,
      };
    },
  });

  assert.ok(trace.symbolsQueried.includes("CodingAgent"));
  assert.ok(
    trace.filesRead.some((file) => file.endsWith("packages/agent-sdk/src/agent/agent.ts")),
    "read_symbol should count the owning file as read",
  );
});

// ─── Reporter Tests ────────────────────────────────────────────

test("buildReport generates correct summary", () => {
  const tasks: BenchmarkTask[] = [
    {
      id: "navigation/find-foo",
      title: "Find foo",
      category: "navigation",
      prompt: "Find foo",
      rubric: { expectedOutputPatterns: ["foo"] },
    },
    {
      id: "editing/fix-bar",
      title: "Fix bar",
      category: "editing",
      prompt: "Fix bar",
      rubric: { expectedOutputPatterns: ["bar"] },
    },
  ];

  const traces: BenchmarkTrace[] = [
    makeTrace({ taskId: "navigation/find-foo", response: "Found foo" }),
    makeTrace({ taskId: "editing/fix-bar", response: "No match here" }),
  ];

  const report = buildReport(tasks, traces, "baseline", "test-model");

  assert.equal(report.summary.totalTasks, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.passRate, 0.5);
  const navStats = report.summary.byCategory["navigation"];
  assert.ok(navStats);
  assert.equal(navStats.passed, 1);
  const editStats = report.summary.byCategory["editing"];
  assert.ok(editStats);
  assert.equal(editStats.passed, 0);
});

test("buildReport throws for unknown task id in trace", () => {
  assert.throws(
    () => buildReport([], [makeTrace({ taskId: "unknown/task" })], "v1", "m"),
    /No task definition found/,
  );
});

test("formatReport produces readable output", () => {
  const tasks: BenchmarkTask[] = [
    {
      id: "navigation/find-foo",
      title: "Find foo",
      category: "navigation",
      prompt: "Find foo",
      rubric: { expectedOutputPatterns: ["foo"] },
    },
  ];
  const traces = [makeTrace({ taskId: "navigation/find-foo", response: "Found foo" })];
  const report = buildReport(tasks, traces, "baseline", "test-model");
  const output = formatReport(report);

  assert.ok(output.includes("Benchmark Report: baseline"));
  assert.ok(output.includes("Model: test-model"));
  assert.ok(output.includes("1/1 passed"));
  assert.ok(output.includes("[PASS] navigation/find-foo"));
});

test("compareReports shows improvements and regressions", () => {
  const tasks: BenchmarkTask[] = [
    {
      id: "navigation/find-foo",
      title: "Find foo",
      category: "navigation",
      prompt: "Find foo",
      rubric: { expectedOutputPatterns: ["foo"] },
    },
  ];

  const baseTraces = [makeTrace({ taskId: "navigation/find-foo", response: "no match" })];
  const candTraces = [makeTrace({ taskId: "navigation/find-foo", response: "Found foo" })];

  const baseline = buildReport(tasks, baseTraces, "baseline", "test-model");
  const candidate = buildReport(tasks, candTraces, "v2", "test-model");

  const comparison = compareReports(baseline, candidate);
  assert.ok(comparison.includes("baseline"));
  assert.ok(comparison.includes("v2"));
  assert.ok(comparison.includes("FIXED"));
});

test("compareReports detects regressions", () => {
  const tasks: BenchmarkTask[] = [
    {
      id: "navigation/find-foo",
      title: "Find foo",
      category: "navigation",
      prompt: "Find foo",
      rubric: { expectedOutputPatterns: ["foo"] },
    },
  ];

  const baseTraces = [makeTrace({ taskId: "navigation/find-foo", response: "Found foo here" })];
  const candTraces = [makeTrace({ taskId: "navigation/find-foo", response: "no match" })];

  const baseline = buildReport(tasks, baseTraces, "baseline", "test-model");
  const candidate = buildReport(tasks, candTraces, "v2", "test-model");

  const comparison = compareReports(baseline, candidate);
  assert.ok(comparison.includes("REGRESSED"));
});

// ─── Integration: Load real tasks from benchmarks/ ─────────────

test("loads real benchmark tasks from benchmarks/tasks/", async () => {
  const tasksDir = path.resolve(import.meta.dirname, "..", "benchmarks", "tasks");
  const tasks = await loadBenchmarkTasks(tasksDir);

  assert.ok(tasks.length >= 20, `Expected at least 20 tasks, got ${tasks.length}`);

  // Verify each task has required fields
  for (const task of tasks) {
    assert.ok(task.id, "task must have an id");
    assert.ok(task.title, "task must have a title");
    assert.ok(task.prompt, "task must have a prompt");
    assert.ok(task.category, "task must have a category");
    assert.ok(task.rubric, "task must have a rubric");
  }

  // Check categories are covered
  const categories = new Set(tasks.map((t) => t.category));
  assert.ok(categories.has("navigation"));
  assert.ok(categories.has("editing"));
  assert.ok(categories.has("refactors"));
  assert.ok(categories.has("debugging"));
  assert.ok(categories.has("planning"));
});
