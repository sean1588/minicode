# Type-Aware Dependency Cone Pruning for Code Agent Context Optimization

## Abstract

Large language model (LLM) coding agents operate in iterative loops — reading source files, reasoning about changes, and calling tools to edit code. In practice, file-read operations consume 67–76% of all tokens in a typical agent session. When these agents are backed by small, locally-run models (7B–14B parameters), this bloated context directly degrades output quality: attention dilutes across irrelevant code, positional biases cause mid-context information loss, and inference latency grows linearly with token count on consumer hardware.

We propose **type-aware dependency cone pruning** — a static analysis technique that exploits the formal structure of typed programming languages to deliver only the minimal code context an agent needs for a given task. Rather than sending whole files, the system uses the TypeScript compiler API to build a project-wide symbol index with resolved types, then extracts the **dependency cone** of a target symbol: its body, the types it references, and the signatures of functions it calls — nothing more. A compact code map (all signatures, no bodies) provides global orientation at fixed cost.

Preliminary analysis on representative agent tasks suggests this approach can reduce read-context tokens by approximately 68%, making small local models viable for tasks that currently require frontier-scale models with 200K+ token context windows.

## 1. The Attention Dilution Problem in Coding Agents

### 1.1 Context Length Degrades Quality — Even with Perfect Retrieval

A common assumption is that longer context windows solve the information access problem: if the answer is in the context, the model will find it. Recent research contradicts this directly.

**"Context Length Alone Hurts LLM Performance Despite Perfect Retrieval"** (arXiv:2510.05381, 2025) demonstrates that even when irrelevant tokens are replaced with whitespace or masked entirely, LLM performance degrades 13.9–85% as input length increases. The degradation is inherent to the self-attention mechanism, not caused by distraction from irrelevant content. The model simply attends less effectively as the sequence grows.

**"Lost in the Middle"** (Liu et al., 2023, arXiv:2307.03172) establishes the U-shaped attention curve: models attend strongly to the beginning and end of context but exhibit significant accuracy drops for information positioned in the middle. For coding agents that read multiple files sequentially, this means the second and third files read are in the worst attention position.

**"Posterior Salience Attenuation"** (arXiv:2506.08371, 2025) formalizes this as a measurable phenomenon: the salience ratio of relevant tokens decreases as context grows, with the effect amplified in smaller models that have less attention capacity to distribute.

### 1.2 The Disproportionate Impact on Small Models

Frontier models (Claude Sonnet 4, GPT-4o) partially mitigate attention dilution through sheer scale — more attention heads, more layers, more capacity to maintain salience across long sequences. Small models (7B–14B) lack this buffer.

Empirical evidence from test-time training research (arXiv:2512.13898, 2025) shows that small models like Qwen3-4B gain 12.6–14.1 percentage points from context-specific optimization strategies, suggesting that the default long-context inference path wastes substantial model capacity.

For coding agents specifically, the cost compounds across turns. A typical 5-step agent interaction accumulates 8,000–15,000 tokens of read context. On a 7B model with a practical effective window of 8K–16K tokens, this leaves minimal headroom for the system prompt, conversation history, and — critically — the model's own reasoning about what to do.

### 1.3 Read Operations Dominate Token Budgets

SWE-Pruner (arXiv:2601.16746, 2025) quantifies the breakdown: in multi-turn coding agent sessions on SWE-Bench, **read operations account for 67–76% of total tokens consumed**. The remaining tokens are split among system prompts, conversation turns, and tool call metadata.

This establishes read context as the dominant optimization target. Reducing read tokens by half would reduce total session tokens by 34–38% — potentially enough to bring an entire agent session within the effective window of a small local model.

## 2. Why Code Is Uniquely Suited to Structured Pruning

Natural language resists aggressive pruning because meaning is distributed across sentences, paragraphs, and discourse structure. Removing a sentence may eliminate context that changes the interpretation of later text. Code is fundamentally different.

### 2.1 Deterministic Formal Structure

Source code has a precise, machine-parseable structure defined by a formal grammar. Every function, class, type, and variable occupies a well-defined position in an abstract syntax tree (AST). This structure is not probabilistic or ambiguous — it is exact. A parser can identify every symbol, its boundaries, and its syntactic role with certainty.

### 2.2 Explicit Type Systems

In typed languages like TypeScript, the type system provides a formal contract for every symbol. A function signature `async chat(params: ChatParams): Promise<ModelResponse>` tells you exactly what the function accepts and returns — without reading its body. This is a lossless compression of the function's interface: another function that calls `chat` needs only this signature to generate a correct call site.

Untyped languages (vanilla JavaScript, Python) lack this property. Type annotations are the key enabler — they make signatures informationally complete for the purpose of writing code that interacts with a symbol.

### 2.3 Explicit Dependency Graphs

Code has two kinds of dependencies, both machine-resolvable:

1. **Static imports:** `import { X } from "./module"` — a directed edge in a module dependency graph
2. **Symbol references:** Function A calls function B, uses type T, extends class C — directed edges in a call/type graph

These graphs are computable from the AST and type checker. Given a target symbol, we can compute the **dependency cone** — the transitive closure of all symbols it depends on — and know with certainty that no code outside this cone is needed to understand or correctly modify the target.

This is not possible with natural language, where references are implicit, ambiguous, and context-dependent.

### 2.4 The Signature-Body Separation

Code naturally separates **interface** (what a thing does) from **implementation** (how it does it). A function signature, a class declaration, an interface definition — these are compact descriptions that external code depends on. The body is only relevant when modifying or deeply understanding that specific function.

This separation means we can send the entire project's interface (all signatures) at minimal cost, and only fetch implementations on demand. For a 100-file TypeScript project, the full signature map might be 1,000–1,500 tokens — compared to 50,000–100,000 tokens for all source code.

## 3. The Type-Aware Dependency Cone Hypothesis

### 3.1 Definition

Given a target symbol S in a typed codebase, the **type-aware dependency cone** of S is the set containing:

1. The full source of S (body + signature)
2. The type definitions of all types referenced by S (parameters, return types, local variables)
3. The signatures (not bodies) of all functions/methods called by S
4. Recursively, the type definitions referenced by those signatures (to depth D, default D=2)

We hypothesize that this dependency cone contains **sufficient context for an LLM to correctly understand, modify, or extend S** — and that all code outside the cone is irrelevant noise that degrades model performance.

### 3.2 Formal Framing

Let P be a project with symbol set {S1, S2, ..., Sn}. Let deps(Si, d) be the dependency cone of Si at depth d. Let tokens(X) be the token count of a code fragment X. Let quality(M, C, T) be the quality of model M's output on task T given context C.

We hypothesize:

```
For scoped editing tasks T targeting symbol Si:
  quality(M, deps(Si, 2), T) >= quality(M, full_files(Si), T)
  while tokens(deps(Si, 2)) << tokens(full_files(Si))
```

That is: the dependency cone provides equal or better quality (by eliminating attention dilution) at dramatically lower token cost. The improvement is expected to be most pronounced for small models M where attention capacity is the binding constraint.

### 3.3 Why "Type-Aware" Matters

A purely syntactic approach (e.g., tree-sitter) can identify that function A calls something named "parseResponse". But it cannot determine:

- Which `parseResponse` — there may be multiple across the project
- What type `parseResponse` returns — needed to understand how A uses the result
- Whether a variable's type matches an interface from another module

The TypeScript type checker resolves all of these. It follows import chains, resolves overloads, narrows types through control flow, and provides the fully qualified identity of every symbol. This turns the dependency cone from an approximation into a precise subgraph.

## 4. Comparison of Context Pruning Strategies

### 4.1 Structural Pruning (AST-Based)

Uses the syntactic structure of code to identify and extract relevant fragments.

- **Mechanism:** Parse AST → identify symbol boundaries → extract by declaration
- **Strengths:** Deterministic, fast, no training data needed, preserves syntactic validity
- **Weaknesses:** No understanding of task relevance — extracts everything a symbol depends on, whether or not it is relevant to the specific edit
- **Examples:** Aider repo map, proposed dependency cone approach

### 4.2 Semantic Pruning (Embedding-Based)

Uses vector similarity to retrieve code fragments relevant to a natural language query.

- **Mechanism:** Embed code chunks → embed query → retrieve by cosine similarity
- **Strengths:** Task-aware, can find semantically related code that has no syntactic connection
- **Weaknesses:** Requires embedding model (additional compute), chunk boundaries are arbitrary (not aligned to symbol boundaries), retrieval is probabilistic (may miss critical dependencies)
- **Examples:** RAG-based coding assistants, Cursor's codebase indexing

### 4.3 Neural Pruning (Learned Skimmers)

Trains a small model to select relevant lines given a task description.

- **Mechanism:** Task goal → learned relevance scoring per line → threshold/select
- **Strengths:** Most adaptive, learns patterns of relevance from training data
- **Weaknesses:** Requires training data, requires inference of the skimmer model (additional compute and latency), may not preserve syntactic validity
- **Examples:** SWE-Pruner (0.6B parameter skimmer)

### 4.4 Hybrid: Structural + Task-Aware Ranking

The most promising direction combines structural extraction with lightweight task-aware ranking:

1. **Structural extraction** provides the candidate set (all symbols in the dependency cone)
2. **Task-aware ranking** orders candidates by relevance to the current agent goal
3. **Token budgeting** truncates the ranked list to fit the model's effective context

The ranking step can be as simple as keyword matching between the user's task description and symbol names/comments, or as sophisticated as a small embedding model. Crucially, the structural step ensures we never miss a true dependency — we may include some irrelevant symbols, but we do not omit critical ones.

## 5. The Small Model Viability Thesis

### 5.1 Claim

Structured context curation is the single highest-leverage intervention for making sub-14B parameter models competitive with frontier models on **scoped** coding tasks (single-function edits, bug fixes, adding error handling, implementing a method to match an interface).

### 5.2 Reasoning

Small models fail on coding tasks primarily because:

1. **Context overflow:** The accumulated context exceeds their effective window, and quality collapses
2. **Attention dilution:** Even within the window, irrelevant code dilutes attention from the critical symbols
3. **Instruction following:** With less capacity, the model struggles to maintain the system prompt's instructions when context is large

Structured pruning directly addresses all three:

1. Context is reduced by 50–90%, fitting comfortably in small windows
2. Every token in context is relevant to the task, maximizing attention utility
3. Less noise means the model's limited capacity is spent on the task, not on filtering

### 5.3 Scope Limitations

This thesis applies to **scoped tasks** — edits to a specific function, implementation of a defined interface, localized bug fixes. It does not claim small models can match frontier models on:

- Large-scale refactoring across many files
- Architectural decisions requiring holistic codebase understanding
- Tasks where the relevant code cannot be identified statically (runtime-determined behavior)

For these tasks, frontier models with large context windows remain necessary. The thesis is that the majority of day-to-day coding tasks are scoped, and structured pruning makes small models sufficient for them.

## 6. Open Questions

### 6.1 Runtime Dependencies and Dynamic Dispatch

Static analysis cannot capture:
- `eval()`, dynamic `import()`, computed property access
- Dependency injection where the concrete implementation is determined at runtime
- Event emitters where the connection between producer and consumer is implicit

When the dependency cone misses a runtime dependency, the model lacks context it needs. Mitigation strategies include: flagging symbols that use dynamic patterns, falling back to file-level reads for flagged modules, and allowing the model to request additional context when it detects ambiguity.

### 6.2 Cross-Module Side Effects

A function may depend not on another function's return value but on its side effects (writing to a shared variable, modifying a passed-in object, updating global state). Side effect analysis is possible but significantly more complex than reference analysis. The initial approach accepts this limitation and relies on the model's ability to recognize when it needs more context.

### 6.3 Optimal Dependency Depth

How deep should the dependency cone extend? Depth 1 (direct dependencies only) may miss transitive type information. Depth 3+ may include most of the project. The optimal depth likely varies by task and project structure. Empirical evaluation on representative tasks is needed to establish defaults.

### 6.4 When to Fall Back to Full-File Context

The system needs heuristics for when structured pruning is insufficient:
- Non-code files (configuration, documentation, data files)
- Files with heavy metaprogramming or code generation
- When the model explicitly requests full file context after receiving a pruned view
- When the dependency cone exceeds the token budget (suggesting the code is too interconnected for surgical extraction)

### 6.5 Evaluation Methodology

Measuring the effectiveness of context pruning requires:
- A benchmark of representative coding tasks with known-correct solutions
- Token usage measurement with and without pruning
- Quality measurement (correctness of generated edits) with and without pruning
- Testing across model sizes (7B, 14B, 32B, frontier) to quantify the size-dependent benefit
- Comparison against existing approaches (Aider repo map, full-file baseline)

Establishing this benchmark is a prerequisite for principled optimization of the pruning strategy.

## References

1. Liu, N.F., Lin, K., Hewitt, J., Paranjape, A., Bevilacqua, M., Petroni, F., & Liang, P. (2023). "Lost in the Middle: How Language Models Use Long Contexts." arXiv:2307.03172.
2. "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval." arXiv:2510.05381, 2025.
3. Wang, Z., et al. (2025). "SWE-Pruner: Self-Adaptive Context Pruning for Coding Agents." arXiv:2601.16746.
4. "Posterior Salience Attenuation in Long-Context LLMs." arXiv:2506.08371, 2025.
5. "Let's (not) just put things in Context: Test-Time Training for Long-Context LLMs." arXiv:2512.13898, 2025.
6. Gauthier, P. (2023). "Building a better repository map with tree sitter." Aider Blog. https://aider.chat/2023/10/22/repomap.html
7. Microsoft. "Using the TypeScript Compiler API." https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
