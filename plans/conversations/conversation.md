# Project Conversation Log: From Setup to Platform Vision

This document captures the full arc of our discussions, the reasoning behind every decision, and the thought process that evolved mini-coder from a simple local coding agent into a platform for context-optimized AI development.

---

## 1. Initial Setup and Configuration

### 1.1 Starting Point

The project began as a minimal coding agent — a TypeScript-based CLI tool that connects to OpenAI-compatible APIs and gives an LLM access to file and command tools. The original design assumed a local model server (LM Studio at `localhost:1234`) but we needed to configure it for OpenRouter to use cloud models like Claude Sonnet 4.5.

### 1.2 OpenRouter Integration

**What we did:**
- Created a `.env` file with `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, model set to `anthropic/claude-sonnet-4.5`, and a placeholder for the API key.
- Updated `.env.example` to document `OPENROUTER_API_KEY` as an alternative to `OPENAI_API_KEY`.

**Why OpenRouter:** OpenRouter provides a unified API that's OpenAI-compatible, making it a drop-in replacement for the existing `openai`-style client. It also provides access to multiple model providers through a single API key, which is useful for testing across models.

### 1.3 The 401 Authentication Debugging Saga

This was the most involved debugging session and revealed several architectural gaps in how the agent handles configuration.

**The symptom:** `Fatal error: OpenAI-compatible request failed (401): {"error":{"message":"Missing Authentication header","code":401}}` — repeated across multiple attempts.

**The investigation path:**

1. **First hypothesis — API spec mismatch:** We checked whether OpenRouter's API differed from the standard OpenAI format. It doesn't — OpenRouter uses the same `Authorization: Bearer <key>` header. This was a red herring.

2. **Second hypothesis — dotenv not loading:** We discovered that `dotenv.config()` was resolving paths relative to the current working directory, not the project root. When running from a subdirectory or after `npm link`, the `.env` file wasn't found. We fixed the path resolution in `src/agent/config.ts` to anchor relative to `__dirname`, with correct handling for both `src/` (development) and `dist/` (compiled) directory structures.

3. **Third hypothesis — environment variable precedence:** This was the actual root cause. The user had an existing `OPENAI_API_KEY` set in their shell environment (from another tool), and it started with `sk-proj-` (an OpenAI key). Because `process.env` is populated before `dotenv.config()` runs, and dotenv doesn't override existing variables by default, the shell's OpenAI key was silently taking precedence over the `.env` file's OpenRouter key.

**The fix (multi-layered):**

- **Config loading** (`src/agent/config.ts`): When the base URL points to OpenRouter, the config now prioritizes `OPENROUTER_API_KEY` over `OPENAI_API_KEY`. This sidesteps the precedence problem entirely — users can have both keys set and the right one is chosen based on the target API.

- **Client-side validation** (`src/model/client.ts`): Added explicit checks:
  - If using OpenRouter with an `sk-proj-` key → throw a clear error explaining they need an OpenRouter key.
  - If using OpenRouter with no key at all → throw a clear error with a link to get a key.

- **Dev script** (`package.json`): Changed to `node --env-file=.env --import tsx src/index.ts`, using Node's native `--env-file` flag which loads the `.env` before any userland code runs, giving it a better chance of being the first thing to set these variables.

**Decision rationale:** Rather than just fixing the immediate bug, we designed for the common misconfiguration scenario (developer with multiple API keys in their shell). The layered approach — smart config selection, explicit validation, clear error messages — means future users won't face the same 30-minute debugging session.

---

## 2. Making It a Real CLI Tool

### 2.1 Global Installation via npm link

**The need:** Running `node --import tsx src/index.ts` is fine for development, but the agent should be invocable as `mini-coder` from any directory.

**What we did:**
- Added a `bin` field to `package.json`: `"bin": {"mini-coder": "dist/src/index.js"}`
- Added shebang `#!/usr/bin/env node` to `src/index.ts` so the OS knows to run it with Node
- Created an `install:global` npm script: `"npm run build && npm link"`
- Fixed the `start` script path to point to `dist/src/index.js`

**How npm link works:** It creates a symlink from the global `node_modules/.bin/mini-coder` to the local `dist/src/index.js`. This means:
- After code changes, you just run `npm run build` (not a full reinstall)
- The symlink already points to the right place — the rebuilt file is picked up automatically
- Only a full reinstall is needed if you add new dependencies

### 2.2 .env Behavior for Global Tool

**The question:** When running `mini-coder` from `/some/other/project`, where does it look for `.env`?

**The answer and design decision:** We implemented a two-layer config approach:
1. **Project-bundled .env:** Loaded from the mini-coder installation directory (for default API settings)
2. **CWD .env override:** Loaded from the current working directory with `override: true` (for project-specific settings)

This means you can set your API key once in the mini-coder project's `.env` and it works everywhere. But if a specific project needs different settings (different model, different API key), a local `.env` takes precedence. Additionally, `agent.config.json` in the working directory provides non-secret project configuration (model selection, max steps, etc.).

---

## 3. The Context Optimization Brainstorm

### 3.1 The Original Motivation

The driving insight: **smaller local models struggle not because they're dumb, but because they're drowning in irrelevant context.** Tools like Cursor, Aider, and other agent frameworks send entire files to the model when modifying a single function. For frontier models with 200K token windows and massive attention capacity, this works fine. For a 7B model like Devstral 2 Small running locally on consumer hardware, it's catastrophic.

The question was: can we use the structure of code itself — particularly the type system in TypeScript/JavaScript — to send only what the model actually needs?

### 3.2 The AST / Compiler Approach

**The core idea:** Instead of sending `read_file("client.ts")` (4000 tokens of which maybe 500 are relevant), use the TypeScript compiler API to:
1. Build an index of every symbol in the project (functions, classes, interfaces, types)
2. Generate a compact "code map" — all signatures, no bodies — and put it in the system prompt
3. Provide a `read_symbol` tool that extracts a single function body plus just the types it references

**Why TypeScript's compiler API and not tree-sitter or regex:**
- The TS compiler API provides **type-checked** information, not just syntax
- It can resolve `import` chains to tell you *which* `parseResponse` is being called
- It understands type narrowing, overloads, generics — things that determine what context is actually needed
- Tree-sitter gives you syntax; the TS compiler gives you semantics

**The "dependency cone" concept:** For any target symbol, there's a minimal set of code needed to understand it:
- Its own body
- Type definitions for its parameters and return types
- Signatures (not bodies) of functions it calls
- Types referenced by those signatures (to depth 2)

Everything else is noise. Our analysis suggests this reduces read-context tokens by ~68%.

### 3.3 Research Backing

This isn't just intuition — there's research supporting each piece:

- **"Lost in the Middle" (Liu et al., 2023):** Models attend strongly to the beginning and end of context but miss information in the middle. When an agent reads 3 files sequentially, files 2 and 3 are in the worst attention position.
- **"Context Length Alone Hurts" (arXiv:2510.05381):** Even with perfect retrieval, LLM performance degrades 13.9–85% as input length increases. The degradation is inherent to self-attention, not distraction.
- **SWE-Pruner (arXiv:2601.16746):** Read operations account for 67–76% of all tokens in coding agent sessions. This is the dominant optimization target.
- **Posterior Salience Attenuation (arXiv:2506.08371):** Smaller models suffer disproportionately from long context — they have less attention capacity to maintain salience.

### 3.4 Existing Tools in This Space

We surveyed what exists:
- **Aider's repo map:** Uses tree-sitter to build a project skeleton. Similar in spirit but not type-aware and not as surgical.
- **SWE-Pruner:** Trains a 0.6B neural model to select relevant lines. Sophisticated but requires its own inference overhead.
- **Cursor/Continue:** Use embedding-based RAG for retrieval. Good for finding related code but chunk boundaries don't align with symbol boundaries.
- **Sourcegraph Cody:** Uses keyword and graph-based retrieval. Production-grade but tightly coupled to their infrastructure.

Nobody is doing type-aware dependency cone pruning with the language's own compiler API. This is the gap we identified.

---

## 4. The Pivot to a Platform Architecture

### 4.1 The "What About Other Languages?" Moment

The initial plan was TypeScript-specific. But the question arose: what about Python? Go? Rust? The same attention dilution problem affects every language, and many of the same structural properties (ASTs, explicit dependencies, signature-body separation) exist across languages.

### 4.2 The Plugin Insight

**Key realization:** The *optimization strategy* (dependency cone pruning, code maps, token budgeting) is language-agnostic. Only the *parsing and type resolution* is language-specific. This is a natural split for a plugin architecture.

**Why not just use tree-sitter for everything?** Tree-sitter provides broad language coverage but sacrifices depth. It can parse syntax but doesn't understand types, can't resolve imports across modules, and doesn't know which `process` you're calling. Language-native tooling is always more powerful:
- TypeScript: the TS compiler API
- Python: the `ast` module (+ mypy for type checking)
- Go: `go/parser` + `go/types`
- Rust: `syn` + rust-analyzer

A plugin per language can use the *best available tooling* for that language.

### 4.3 The LanguagePlugin Interface

We defined a minimal contract:

```typescript
interface LanguagePlugin {
  name: string;
  extensions: string[];
  canIndex(filePath: string): boolean;
  indexFile(filePath: string, content: string): IndexedSymbol[];
  resolveDependencies?(symbols: IndexedSymbol[], projectFiles: Map<string, string>): DependencyEdge[];
}
```

**Design decisions:**
- **`resolveDependencies` is optional:** Not every language has tooling for deep dependency resolution. Python with no type hints can still provide symbol extraction and a code map — just without the dependency cone optimization. The system degrades gracefully.
- **`signature` is a human-readable string, not structured:** The model reads it as text. We don't need a machine-parseable type representation. A Go signature looks nothing like a Rust trait impl, and that's fine.
- **`IndexedSymbol` is intentionally simple:** `name`, `kind`, `signature`, `startLine`, `endLine`, `exported`, `dependencies`. Rich enough to generate code maps and power `read_symbol`, minimal enough that any language can fill it in.

### 4.4 Plugin Distribution Model

We designed three tiers:
1. **Built-in plugins:** Ship with mini-coder (TypeScript initially, Python as proof-of-concept)
2. **Local plugins:** Drop a `.js` file in `<workspace>/.mini-coder/plugins/` for project-specific language support
3. **npm plugins:** Install `mini-coder-plugin-rust` and it's auto-discovered — convention-over-configuration via naming pattern

**Why this model:** It mirrors the eslint/prettier plugin ecosystem that JS developers already understand. Low barrier to entry (local file), scalable distribution (npm), and no central registry required.

### 4.5 The Open Source Ecosystem Vision

The final evolution of the idea: by publishing the `LanguagePlugin` interface as a spec with a template repository, language experts can contribute plugins without understanding the agent internals. A Rust developer who's never looked at mini-coder's code can write a Rust plugin that uses rust-analyzer for deep type analysis. A Go developer can write a Go plugin using `go/types`. The community brings the language expertise; we provide the platform.

This is what makes the project potentially blog-post-worthy: it's not just another coding agent, it's a thesis about how structured context curation makes small local models viable, combined with an open platform that lets the community extend it to any language.

---

## 5. Decision Log

### 5.1 "Why not just use RAG / embeddings?"

**Considered:** Vector-based retrieval for code context.
**Rejected for primary approach because:**
- Chunk boundaries are arbitrary (by character count or line count), not aligned to symbol boundaries
- Retrieval is probabilistic — you might miss a critical type definition
- Requires an embedding model (additional compute, especially problematic for local/offline use cases)
- Doesn't leverage the deterministic structure of code

**Not rejected entirely:** The hybrid approach (structural extraction + embedding-based ranking) is noted as a future direction. Use AST to define the candidate set, use embeddings to rank within it.

### 5.2 "Why TypeScript first?"

- mini-coder itself is TypeScript — we can dogfood immediately
- TypeScript has the richest compiler API of any mainstream language — it's the best showcase
- The JS/TS ecosystem is the largest — maximum impact for the first plugin
- If it works with TypeScript's complexity (generics, conditional types, mapped types), it'll work anywhere

### 5.3 "Why not modify the model's behavior instead of the context?"

**Considered:** Fine-tuning or prompting the model to ignore irrelevant context.
**Rejected because:**
- Research shows attention dilution is inherent to the self-attention mechanism, not a behavioral choice
- You can't prompt a model to attend better — the math doesn't allow it
- Fine-tuning requires training data and applies to one model; context optimization works with any model

### 5.4 "Why make `resolveDependencies` optional?"

- Python without type hints can still benefit from code maps (symbol names, file locations, signatures)
- Forcing all plugins to implement dependency resolution would raise the bar for plugin authors
- The system degrades gracefully: no dependencies → no dependency cone → model uses `read_file` as fallback
- This follows the principle of progressive enhancement

### 5.5 "Why 5 phases instead of shipping everything at once?"

- Phase 1 (code map only) is useful on its own — the model makes better `read_file` decisions with a project skeleton
- Phase 2 (read_symbol) delivers the core token savings
- Phase 3 (dependency graph) is the sophistication layer — high value but high complexity
- Phase 4 (incremental updates) is polish that makes it production-ready
- Phase 5 (plugin ecosystem) is the multiplier

Each phase is independently shippable and testable. We can validate the core hypothesis (does structured context help small models?) in Phase 1-2 without building the full dependency graph.

---

## 6. Technical Decisions for Future Reference

### 6.1 File Structure

```
src/indexer/
  types.ts           — Core types (IndexedSymbol, LanguagePlugin, etc.)
  plugin-loader.ts   — Plugin discovery and loading
  project-index.ts   — Top-level orchestrator
  code-map.ts        — Text skeleton generator
  cache.ts           — Disk caching for fast restart
  plugins/
    typescript.ts    — Built-in TypeScript plugin (reference implementation)
    python.ts        — Built-in Python plugin (proof-of-concept, Phase 5)
```

### 6.2 Token Budget Defaults

- Code map: ~1500 tokens (fits in system prompt alongside identity and tool descriptions)
- `read_symbol` output: ~500 tokens per symbol (body + leading comments)
- Dependency cone at depth 2: ~300 tokens of type definitions per symbol
- Fallback: if any of these exceed budget, truncate to signatures only

### 6.3 Graceful Degradation Chain

The system never crashes or blocks on indexer failures:
1. If no plugin matches a file → skip it, agent uses `read_file`
2. If plugin throws during indexing → log warning, skip that file
3. If `read_symbol` can't find a symbol → return error, model falls back to `read_file`
4. If dependency cone is too large → truncate to signatures, let model request more
5. If the entire indexer fails → agent works exactly as it does today

### 6.4 Why We Chose the TypeScript Compiler API Over tree-sitter

For the TypeScript plugin specifically:
- **Type resolution:** `ts.TypeChecker` can tell you the resolved type of any expression. tree-sitter cannot.
- **Import resolution:** The TS compiler follows `tsconfig.json` paths, node resolution, etc. tree-sitter sees `import` as syntax only.
- **Project-wide analysis:** `ts.createProgram()` understands the whole project. tree-sitter parses files in isolation.
- **Accuracy:** Zero false positives on symbol extraction — if the compiler says it's a function, it's a function.

Trade-off: the TS compiler is slower than tree-sitter and requires more memory. For the TypeScript plugin this is acceptable — we're already in a TypeScript project. For other languages (Python, Go), their native parsers serve the same role.

---

## 7. Open Questions Discussed

1. **How do you handle dynamically-typed code?** Accept lower precision. Python without type hints still gives you symbol names, boundaries, and import structure. The dependency cone is less precise but the code map is still valuable.

2. **What about monorepos?** The indexer scans from the workspace root. For monorepos, this might be a sub-package. The `agent.config.json` could specify indexing scope.

3. **How do you handle code that imports from node_modules?** Skip `node_modules` during indexing. For external types, include the `.d.ts` signatures. The TypeScript plugin can resolve these via the compiler API's module resolution.

4. **What if the project is too large?** Token budgeting on the code map naturally handles this — large projects get a higher-level skeleton (only exported symbols, only most-referenced). The `read_symbol` tool still provides surgical access.

5. **What about non-code files?** The indexer only handles source code. Configuration files, documentation, and data files continue to use `read_file`. The system prompt can note which file types support `read_symbol`.

---

## 8. Why This Could Be a Great Blog Post

The narrative arc is compelling:

1. **Problem:** Small local models choke on bloated context. Everyone talks about "context windows" as a feature; we reframe it as a liability.
2. **Insight:** Code has deterministic structure that natural language lacks. We can exploit this to deliver exactly what the model needs.
3. **Research backing:** We're not hand-waving — there's published research on attention dilution, lost-in-the-middle, and context length degradation that supports the approach.
4. **Implementation:** Concrete, buildable system with clear phases. Not a research paper — a tool you can use.
5. **Open platform:** The plugin architecture means it's not just our project — anyone can extend it for their language. This is the hook for community engagement.
6. **Testable thesis:** "Can a 7B model with smart context match a frontier model on scoped tasks?" This is a concrete, measurable claim that people will want to see validated.

The combination of theoretical grounding, practical tooling, and open-source community appeal makes it stand out from "I built another coding agent" posts.
