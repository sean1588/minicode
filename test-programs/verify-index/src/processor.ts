import type { Task, Result, TaskRunner } from "./types.js";
import { parseAndProcess } from "./parser.js";

/**
 * Processor implements TaskRunner.
 * run() calls parseAndProcess().
 */
export class Processor implements TaskRunner {
  async run(task: Task): Promise<Result> {
    return parseAndProcess(task.input);
  }
}
