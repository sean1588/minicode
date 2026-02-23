import type { Task, Result } from "./types.js";

/**
 * Parses raw input into a Task.
 * Referenced by Processor.run().
 */
export function parse(input: string): Task {
  return {
    id: crypto.randomUUID(),
    input: input.trim(),
  };
}

/**
 * Processes a Task and produces a Result.
 * Called by parseAndProcess().
 */
export function process(task: Task): Result {
  return {
    success: true,
    output: `Processed: ${task.input}`,
  };
}

/**
 * Combines parse and process. Used by Processor.
 */
export function parseAndProcess(input: string): Result {
  const task = parse(input);
  return process(task);
}
