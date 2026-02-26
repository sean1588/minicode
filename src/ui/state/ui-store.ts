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
  activityItems: ActivityItem[];
  errorMessage: string | null;
}

const DEFAULT_STATE: UiStoreState = {
  phase: "idle",
  step: 0,
  maxSteps: 25,
  inputTokens: 0,
  outputTokens: 0,
  model: "",
  workspaceRoot: "",
  indexStatus: "",
  activityItems: [],
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

  addActivityItem(item: ActivityItem): void {
    this.update({
      activityItems: [...this.state.activityItems, item],
    });
  }

  updateLastToolCall(update: Partial<ActivityItemToolCall>): void {
    const items = [...this.state.activityItems];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last && last.type === "tool_call") {
      items[lastIdx] = { ...last, ...update };
      this.update({ activityItems: items });
    }
  }

  replaceLastThinking(content: string): void {
    const items = [...this.state.activityItems];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last && last.type === "thinking") {
      items[lastIdx] = { ...last, content };
      this.update({ activityItems: items });
    }
  }

  setError(message: string): void {
    this.update({ phase: "error", errorMessage: message });
  }

  clearActivityPane(): void {
    this.update({ activityItems: [] });
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.notify();
  }
}
