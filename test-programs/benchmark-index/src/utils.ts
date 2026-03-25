import type { EventHandler } from "./types.js";

/**
 * Arrow function assigned to const.
 */
export const formatMessage = (prefix: string, msg: string): string => {
  return `[${prefix}] ${msg}`;
};

/**
 * Function expression assigned to const.
 */
export const parseEvent = function (raw: string): string {
  return raw.trim().toLowerCase();
};

/**
 * Regular function declaration.
 */
export function createHandler(prefix: string): EventHandler {
  return (event: string) => {
    console.log(formatMessage(prefix, event));
  };
}
