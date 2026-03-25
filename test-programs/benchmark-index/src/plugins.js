/**
 * BasePlugin - class declaration in JS, used as a base class.
 */
export class BasePlugin {
  constructor(name) {
    this.name = name;
  }

  init() {
    console.log(`Plugin ${this.name} initialized`);
  }
}

/**
 * AuthPlugin extends BasePlugin.
 */
export class AuthPlugin extends BasePlugin {
  constructor() {
    super("auth");
  }

  init() {
    super.init();
    this.setupAuth();
  }

  setupAuth() {
    console.log("Auth configured");
  }
}

/**
 * Factory function using new expression.
 */
export function createPlugin(name) {
  if (name === "auth") {
    return new AuthPlugin();
  }
  return new BasePlugin(name);
}
