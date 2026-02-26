import type {
  ActivityItem,
  ActivityItemToolCall,
  UiPhase,
} from "../events.js";

type Listener = () => void;

export interface UiStoreState {
  phase: UiPhase;
  step: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  workspaceRoot: string;
  indexStatus: string;
  items: ActivityItem[];
  errorMessage: string | null;
}

const DEFAULT_STATE: UiStoreState = {
  phase: "idle",
  step: 0,
  maxSteps: 50,
  inputTokens: 0,
  outputTokens: 0,
  model: "",
  workspaceRoot: "",
  indexStatus: "",
  items: [],
  errorMessage: null,
};

export class UiStore {
  private state: UiStoreState = { ...DEFAULT_STATE };
  private listeners = new Set<Listener>();

  getState(): UiStoreState {
    return { ...this.state };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private update(partial: Partial<UiStoreState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  setConfig(config: {
    model: string;
    workspaceRoot: string;
    maxSteps: number;
    indexStatus: string;
  }): void {
    this.update(config);
  }

  setPhase(phase: UiPhase): void {
    this.update({ phase });
  }

  setStep(step: number): void {
    this.update({ step });
  }

  setTokenUsage(inputTokens: number, outputTokens: number): void {
    this.update({ inputTokens, outputTokens });
  }

  addItem(item: ActivityItem): void {
    this.update({
      items: [...this.state.items, item],
    });
  }

  updateLastToolCall(update: Partial<ActivityItemToolCall>): void {
    const items = [...this.state.items];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.type === "tool_call") {
        items[i] = { ...it, ...update };
        this.update({ items });
        return;
      }
    }
  }

  setError(message: string): void {
    this.update({ phase: "error", errorMessage: message });
  }

  clearAll(): void {
    this.update({ items: [] });
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.notify();
  }
}
