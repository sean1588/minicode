/**
 * Shared types for the verify-index test program.
 * Referenced by parse(), Processor, and process().
 */
export interface Task {
  id: string;
  input: string;
}

export interface Result {
  success: boolean;
  output: string;
}

export interface TaskRunner {
  run(task: Task): Promise<Result>;
}
