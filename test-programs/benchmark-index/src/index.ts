import { App } from "./app.js";
import { createLogger } from "./logger.js";

export async function main(): Promise<void> {
  const logger = createLogger("main");
  const app = new App(logger);
  await app.start();
}

main().catch(console.error);
