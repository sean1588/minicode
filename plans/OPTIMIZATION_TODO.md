# Context Optimization TODO

Captured from optimization recommendations. Items ordered by impact.

## High Impact

- [x] **read_file default limit** — When no `offset`/`limit` is provided, return full file. For large files (5k+ lines) this can dump tens of thousands of tokens. Add soft cap: if file > ~500 lines and no limit specified, return first 500 lines with note `[... truncated, use offset/limit to read more]`.

- [x] **run_command output truncation** — Commands like `npm run build`, `ls -la`, or `git status` in large repos can produce huge stdout/stderr. Add truncation (e.g. 8k–12k chars) with truncation note. Exit code and timed_out always returned.

- [x] **find_references / get_dependencies caps** — Heavily-used symbols can return hundreds of references; `get_dependencies` with depth 2+ can explode. Cap results (e.g. 50 items) with `... and N more` when truncated.

## Medium Impact

- [x] **list_files exclusions** — Listing `node_modules` or `.git` returns thousands of entries. Exclude `node_modules`, `.git`, `.mini-coder` by default, or cap max entries.

- [ ] **Global tool output cap** — Tool results go into session as-is. A single huge result can dominate context. Add configurable max (e.g. 15k chars) and truncate tool outputs before adding to session.

- [ ] **Document maxContextTokens for small models** — Default 120k is too high for 8k–32k context models. Document that users of small models should set `MAX_CONTEXT_TOKENS` to match their model’s context window.

## Lower Priority

- [ ] **Code map budget** — Default 1500 tokens is reasonable. Consider making configurable for tuning.

- [ ] **Compact prompt mode** — For small-context models, a mode with shorter tool descriptions and smaller code map.

- [ ] **Session trim tuning** — Document `keepRecentMessages` tuning for different conversation lengths.

## Config Tweaks for Small Models

Document recommended settings for models like gpt-oss-20b (~8k context):

```
MAX_CONTEXT_TOKENS=6000   # Leave room for response
KEEP_RECENT_MESSAGES=8    # Fewer messages to fit
MAX_STEPS=15              # Shorter turns
```
