/**
 * Generates benchmark reports from evaluation results and traces.
 */

import type {
  BenchmarkEvaluation,
  BenchmarkReport,
  BenchmarkResult,
  BenchmarkTrace,
  ReportSummary,
  BenchmarkTask,
} from "./types.js";
import { evaluate } from "./evaluator.js";

/**
 * Build a full benchmark report from tasks and their traces.
 */
export function buildReport(
  tasks: BenchmarkTask[],
  traces: BenchmarkTrace[],
  variant: string,
  model: string,
): BenchmarkReport {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const results: BenchmarkResult[] = traces.map((trace) => {
    const task = taskMap.get(trace.taskId);
    if (!task) {
      throw new Error(`No task definition found for trace: ${trace.taskId}`);
    }
    const evaluation = evaluate(task.id, task.rubric, trace);
    return {
      taskId: task.id,
      category: task.category,
      evaluation,
      trace,
    };
  });

  return {
    variant,
    model,
    generatedAt: new Date().toISOString(),
    results,
    summary: computeSummary(results),
  };
}

/**
 * Build a report from pre-computed evaluations and traces.
 */
export function buildReportFromEvaluations(
  evaluations: BenchmarkEvaluation[],
  traces: BenchmarkTrace[],
  tasks: BenchmarkTask[],
  variant: string,
  model: string,
): BenchmarkReport {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const evalMap = new Map(evaluations.map((e) => [e.taskId, e]));

  const results: BenchmarkResult[] = traces.map((trace) => {
    const task = taskMap.get(trace.taskId);
    const evaluation = evalMap.get(trace.taskId);
    if (!task || !evaluation) {
      throw new Error(`Missing task or evaluation for: ${trace.taskId}`);
    }
    return {
      taskId: task.id,
      category: task.category,
      evaluation,
      trace,
    };
  });

  return {
    variant,
    model,
    generatedAt: new Date().toISOString(),
    results,
    summary: computeSummary(results),
  };
}

function computeSummary(results: BenchmarkResult[]): ReportSummary {
  const total = results.length;
  const passed = results.filter((r) => r.evaluation.passed).length;

  // By category
  const byCategory: ReportSummary["byCategory"] = {};
  for (const r of results) {
    const cat = r.category;
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, passed: 0, passRate: 0 };
    }
    byCategory[cat].total += 1;
    if (r.evaluation.passed) byCategory[cat].passed += 1;
  }
  for (const entry of Object.values(byCategory)) {
    entry.passRate = entry.total > 0 ? entry.passed / entry.total : 0;
  }

  // Averages
  const avgToolCalls =
    total > 0
      ? results.reduce(
          (sum, r) => sum + r.evaluation.efficiency.toolCallCount,
          0,
        ) / total
      : 0;
  const avgTotalTokens =
    total > 0
      ? results.reduce(
          (sum, r) => sum + r.evaluation.efficiency.totalTokens,
          0,
        ) / total
      : 0;
  const avgDurationMs =
    total > 0
      ? results.reduce(
          (sum, r) => sum + r.evaluation.efficiency.durationMs,
          0,
        ) / total
      : 0;

  return {
    totalTasks: total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : 0,
    byCategory,
    avgToolCalls,
    avgTotalTokens,
    avgDurationMs,
  };
}

/**
 * Format a report as a human-readable string for terminal output.
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push(`Benchmark Report: ${report.variant}`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");

  // Summary
  const s = report.summary;
  lines.push(
    `Results: ${s.passed}/${s.totalTasks} passed (${(s.passRate * 100).toFixed(1)}%)`,
  );
  lines.push("");

  // By category
  lines.push("By category:");
  for (const [cat, stats] of Object.entries(s.byCategory)) {
    lines.push(
      `  ${cat}: ${stats.passed}/${stats.total} (${(stats.passRate * 100).toFixed(1)}%)`,
    );
  }
  lines.push("");

  // Efficiency
  lines.push("Efficiency (averages):");
  lines.push(`  Tool calls: ${s.avgToolCalls.toFixed(1)}`);
  lines.push(`  Total tokens: ${s.avgTotalTokens.toFixed(0)}`);
  lines.push(`  Duration: ${s.avgDurationMs.toFixed(0)}ms`);
  lines.push("");

  // Per-task details
  lines.push("Task details:");
  for (const r of report.results) {
    const status = r.evaluation.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${r.taskId}`);
    for (const check of r.evaluation.checks) {
      const checkMark = check.passed ? "+" : "-";
      const detail = check.detail ? ` (${check.detail})` : "";
      lines.push(`    [${checkMark}] ${check.name}${detail}`);
    }
    const eff = r.evaluation.efficiency;
    lines.push(
      `    tools: ${eff.toolCallCount}, tokens: ${eff.totalTokens}, files: ${eff.filesReadCount}, symbols: ${eff.symbolsQueriedCount}`,
    );
  }

  return lines.join("\n");
}

/**
 * Compare two reports side by side.
 */
export function compareReports(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): string {
  const lines: string[] = [];

  lines.push(
    `Comparison: "${baseline.variant}" vs "${candidate.variant}"`,
  );
  lines.push(`Models: ${baseline.model} vs ${candidate.model}`);
  lines.push("");

  const bs = baseline.summary;
  const cs = candidate.summary;

  lines.push("Overall:");
  lines.push(
    `  Pass rate: ${(bs.passRate * 100).toFixed(1)}% -> ${(cs.passRate * 100).toFixed(1)}% (${formatDelta(cs.passRate - bs.passRate, true)})`,
  );
  lines.push(
    `  Avg tool calls: ${bs.avgToolCalls.toFixed(1)} -> ${cs.avgToolCalls.toFixed(1)} (${formatDelta(cs.avgToolCalls - bs.avgToolCalls, false)})`,
  );
  lines.push(
    `  Avg tokens: ${bs.avgTotalTokens.toFixed(0)} -> ${cs.avgTotalTokens.toFixed(0)} (${formatDelta(cs.avgTotalTokens - bs.avgTotalTokens, false)})`,
  );
  lines.push(
    `  Avg duration: ${bs.avgDurationMs.toFixed(0)}ms -> ${cs.avgDurationMs.toFixed(0)}ms (${formatDelta(cs.avgDurationMs - bs.avgDurationMs, false)})`,
  );
  lines.push("");

  // Per-task comparison
  const baseResults = new Map(baseline.results.map((r) => [r.taskId, r]));
  lines.push("Per-task changes:");
  for (const cr of candidate.results) {
    const br = baseResults.get(cr.taskId);
    if (!br) {
      lines.push(`  [NEW] ${cr.taskId}: ${cr.evaluation.passed ? "PASS" : "FAIL"}`);
      continue;
    }
    if (br.evaluation.passed !== cr.evaluation.passed) {
      const change = cr.evaluation.passed ? "FIXED" : "REGRESSED";
      lines.push(`  [${change}] ${cr.taskId}`);
    }
  }

  return lines.join("\n");
}

function formatDelta(delta: number, higherIsBetter: boolean): string {
  const sign = delta >= 0 ? "+" : "";
  const formatted = `${sign}${delta.toFixed(1)}`;
  if (Math.abs(delta) < 0.01) return "no change";
  if (higherIsBetter) {
    return delta > 0 ? `${formatted} better` : `${formatted} worse`;
  }
  return delta < 0 ? `${formatted} better` : `${formatted} worse`;
}
