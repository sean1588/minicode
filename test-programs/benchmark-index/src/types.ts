export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface Plugin {
  name: string;
  init(): void;
}

export interface Startable {
  start(): Promise<void>;
}

export type LogLevel = "info" | "warn" | "error";

export type EventHandler = (event: string) => void;
