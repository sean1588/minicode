/** @typedef {import("./types.js").LogLevel} LogLevel */

/**
 * ConsoleLogger - class expression assigned to a variable.
 */
const ConsoleLogger = class ConsoleLogger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  info(msg) {
    console.log(`[${this.prefix}] INFO: ${msg}`);
  }

  error(msg) {
    console.error(`[${this.prefix}] ERROR: ${msg}`);
  }
};

/**
 * Creates a new ConsoleLogger instance.
 */
export function createLogger(prefix) {
  return new ConsoleLogger(prefix);
}

export { ConsoleLogger };
