import type {
  ActivityItem,
  ActivityItemToolCall,
  UiPhase,
} from "../events.js";

type Listener = () => void;

export interface PendingPermissionPrompt {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * Resolves the agent's `beforeToolCall` promise. Set by the permission
   * gate when it parks a prompt; called by the UI when the user picks an
   * option. Cleared from the store as soon as it fires.
   */
  resolve: (
    response: { decision: "allow"; rememberForSession: boolean } | { decision: "deny" },
  ) => void;
}

export interface UiStoreState {
  phase: UiPhase;
  step: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  maxContextTokens: number;
  model: string;
  workspaceRoot: string;
  indexStatus: string;
  items: ActivityItem[];
  errorMessage: string | null;
  /** Set while a mutating tool call is awaiting the user's approval. */
  pendingPermission: PendingPermissionPrompt | null;
  /** When true, the permission gate auto-allows mutating tool calls. */
  autoAllowWrites: boolean;
}

const DEFAULT_STATE: UiStoreState = {
  phase: "idle",
  step: 0,
  maxSteps: 50,
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  model: "",
  workspaceRoot: "",
  indexStatus: "",
  items: [],
  errorMessage: null,
  pendingPermission: null,
  autoAllowWrites: false,
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

  setContextStatus(contextTokens: number, maxContextTokens: number): void {
    this.update({ contextTokens, maxContextTokens });
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

  appendToStreamingContent(chunk: string): void {
    const items = [...this.state.items];
    const last = items[items.length - 1];
    if (last?.type === "assistant") {
      items[items.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
    } else {
      items.push({ type: "assistant", content: chunk });
    }
    this.update({ items });
  }

  setError(message: string | null): void {
    this.update({
      errorMessage: message,
      ...(message !== null ? { phase: "error" as const } : { phase: "idle" as const }),
    });
  }

  clearAll(): void {
    this.update({ items: [] });
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.notify();
  }

  setPendingPermission(prompt: PendingPermissionPrompt | null): void {
    this.update({ pendingPermission: prompt });
  }

  setAutoAllowWrites(value: boolean): void {
    if (this.state.autoAllowWrites === value) return;
    this.update({ autoAllowWrites: value });
  }

  getAutoAllowWrites(): boolean {
    return this.state.autoAllowWrites;
  }
}
