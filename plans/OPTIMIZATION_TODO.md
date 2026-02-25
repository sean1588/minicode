# Optimization TODO

Prioritized list. Keep context small for local models — prefer on-demand (tool output) over always-on (system prompt).

## Recommended Next (Code Understanding, Context-Safe)

- [x] **read_symbol: add "Used by" and "Calls"** — Show who references this symbol (cap 5) and what it calls (cap 5). On-demand only; uses existing index data.

- [x] **read_symbol: add JSDoc/docstring** — Extract and include doc comment when reading a symbol. On-demand only. Add `docComment` to IndexedSymbol; TypeScript: `ts.getJSDocCommentText()`, Python: `__doc__`.

- [x] **System prompt: code reading strategy** — Add 3–5 lines: start with entry points, use find_references for usage, get_dependencies for implementation. ~30–50 tokens, fixed.

## Context Optimization (Remaining)

- [x] **Global tool output cap** — Truncate tool results before adding to session (configurable max ~15k chars). Prevents one huge result from dominating. `MAX_TOOL_OUTPUT_CHARS`, default 15000, 0 to disable.

- [x] **Document maxContextTokens for small models** — Add to README: set `MAX_CONTEXT_TOKENS` to match model window (e.g. 6k for 8k models).

## Lower Priority

- [ ] **Code map budget configurable** — Allow tuning token budget for code map.

- [ ] **Compact prompt mode** — Shorter tool descriptions + smaller code map for small-context models.

- [ ] **Session trim tuning** — Document `keepRecentMessages` for different conversation lengths.

## Deferred (Would Add to Base Context)

- **Code map: JSDoc** — Skip; would bloat system prompt.
- **Code map: reference counts** — Skip; adds tokens per symbol.
- **Code map: project overview** — Optional; keep minimal (3–5 entry points) if added later.

## Config Tweaks for Small Models

Document in README:

```
MAX_CONTEXT_TOKENS=6000   # Leave room for response
KEEP_RECENT_MESSAGES=8    # Fewer messages to fit
MAX_STEPS=15              # Shorter turns
```
