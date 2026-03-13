/**
 * Tracks which symbols the user/agent is actively working with.
 * Used to dynamically re-rank the code map so that relevant symbols
 * survive truncation within the fixed token budget.
 *
 * Focus is derived from:
 * - Symbol names in tool calls (read_symbol, find_references, get_dependencies)
 * - Symbol names mentioned in user messages (fuzzy match against index)
 */

const MAX_FOCUS_SYMBOLS = 30;

export class FocusTracker {
  private readonly focused: Map<string, number> = new Map();
  private generation = 0;

  /**
   * Record a symbol as being actively focused on.
   * More recent additions have higher priority.
   */
  addSymbol(qualifiedName: string): void {
    this.generation += 1;
    this.focused.set(qualifiedName, this.generation);

    // Evict oldest entries if we exceed the limit
    if (this.focused.size > MAX_FOCUS_SYMBOLS) {
      let oldestKey: string | null = null;
      let oldestGen = Infinity;
      for (const [key, gen] of this.focused) {
        if (gen < oldestGen) {
          oldestGen = gen;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.focused.delete(oldestKey);
      }
    }
  }

  /**
   * Record multiple symbols at once (e.g. from dependency expansion).
   */
  addSymbols(qualifiedNames: string[]): void {
    for (const name of qualifiedNames) {
      this.addSymbol(name);
    }
  }

  /**
   * Get the current set of focused symbol qualified names.
   */
  getFocusedSymbols(): Set<string> {
    return new Set(this.focused.keys());
  }

  /**
   * Check if a symbol is currently focused.
   */
  hasFocus(qualifiedName: string): boolean {
    return this.focused.has(qualifiedName);
  }

  /**
   * Clear all focus tracking.
   */
  clear(): void {
    this.focused.clear();
    this.generation = 0;
  }
}
