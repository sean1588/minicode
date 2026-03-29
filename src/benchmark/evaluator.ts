/**
 * Evaluates a benchmark trace against a task's rubric.
 */

import type {
  BenchmarkEvaluation,
  BenchmarkRubric,
  BenchmarkTrace,
  EfficiencyMetrics,
  EvaluationCheck,
} from "./types.js";

/**
 * Evaluate a benchmark trace against the task rubric.
 */
export function evaluate(
  taskId: string,
  rubric: BenchmarkRubric,
  trace: BenchmarkTrace,
): BenchmarkEvaluation {
  const checks: EvaluationCheck[] = [];

  // 1. Check expected output patterns
  if (rubric.expectedOutputPatterns) {
    for (const pattern of rubric.expectedOutputPatterns) {
      const regex = new RegExp(pattern, "i");
      checks.push({
        name: `output matches /${pattern}/i`,
        passed: regex.test(trace.response),
        detail: regex.test(trace.response)
          ? undefined
          : `Pattern not found in response`,
      });
    }
  }

  // 2. Check expected files read
  if (rubric.expectedFilesRead) {
    for (const expectedFile of rubric.expectedFilesRead) {
      const found = trace.filesRead.some(
        (f) => f === expectedFile || f.endsWith(expectedFile),
      );
      checks.push({
        name: `read file ${expectedFile}`,
        passed: found,
        detail: found ? undefined : `File was not read during the run`,
      });
    }
  }

  // 3. Check expected symbols queried
  if (rubric.expectedSymbols) {
    for (const sym of rubric.expectedSymbols) {
      const found = trace.symbolsQueried.some(
        (s) => s === sym || s.includes(sym),
      );
      checks.push({
        name: `queried symbol ${sym}`,
        passed: found,
        detail: found ? undefined : `Symbol was not queried`,
      });
    }
  }

  // 4. Check forbidden patterns
  if (rubric.forbiddenPatterns) {
    for (const pattern of rubric.forbiddenPatterns) {
      const regex = new RegExp(pattern, "i");
      const absent = !regex.test(trace.response);
      checks.push({
        name: `output does NOT match /${pattern}/i`,
        passed: absent,
        detail: absent ? undefined : `Forbidden pattern found in response`,
      });
    }
  }

  // 5. Efficiency metrics
  const efficiency = computeEfficiency(rubric, trace);

  const allChecksPassed = checks.every((c) => c.passed);

  return {
    taskId,
    passed: allChecksPassed,
    checks,
    efficiency,
  };
}

function computeEfficiency(
  rubric: BenchmarkRubric,
  trace: BenchmarkTrace,
): EfficiencyMetrics {
  const toolCallCount = trace.toolCalls.length;
  const totalTokens = trace.usage.totalTokens;

  const withinToolBudget =
    rubric.maxToolCalls == null || toolCallCount <= rubric.maxToolCalls;
  const withinTokenBudget =
    rubric.maxTotalTokens == null || totalTokens <= rubric.maxTotalTokens;

  return {
    toolCallCount,
    totalTokens,
    durationMs: trace.durationMs,
    filesReadCount: trace.filesRead.length,
    symbolsQueriedCount: trace.symbolsQueried.length,
    withinBudget: withinToolBudget && withinTokenBudget,
  };
}
