import type { Logger, Startable } from "./types.js";
import { EventBus } from "./events.js";
import { AuthPlugin } from "./plugins.js";

/**
 * Main application class.
 */
export class App implements Startable {
  private logger: Logger;
  private events: EventBus;

  constructor(logger: Logger) {
    this.logger = logger;
    this.events = new EventBus();
  }

  async start(): Promise<void> {
    const plugin = new AuthPlugin();
    plugin.init();
    this.events.emit("app:started");
    this.logger.info("App started");
  }
}
