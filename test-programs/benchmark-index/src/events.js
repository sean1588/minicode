/**
 * EventBus - anonymous class expression (variable name used as class name).
 */
export const EventBus = class {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
  }

  emit(event) {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach((h) => h(event));
  }
};
