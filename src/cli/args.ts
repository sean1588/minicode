export interface CliArgs {
  verbose: boolean;
  oneshot: boolean;
  task: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const oneshot = args.includes("--oneshot") || args.includes("-1");
  const filtered = args.filter(
    (a) =>
      a !== "--verbose" &&
      a !== "-v" &&
      a !== "--oneshot" &&
      a !== "-1",
  );
  const task = filtered.join(" ").trim();
  return { verbose, oneshot, task };
}

export function validateCliArgs(args: CliArgs): void {
  if (args.oneshot && args.task.length === 0) {
    throw new Error(
      "--oneshot requires a task prompt. Example: minicode --oneshot \"Fix lint errors\"",
    );
  }
}
