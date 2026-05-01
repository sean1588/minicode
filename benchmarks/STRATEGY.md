# Benchmark Strategy

This document describes how to benchmark minicode as an agentic coding harness
and how to use the results to guide product changes. The goal is not just to
produce a one-time score; it is to build an evidence loop for prompt, context,
tooling, and model-profile decisions.

## Goals

- Measure whether minicode is competitive with strong agentic coding harnesses
  when paired with leading frontier models.
- Measure whether minicode's structured context tools help less capable,
  open-source, and local-sized models under realistic context pressure.
- Separate model capability from harness behavior by recording tool usage,
  edit behavior, test behavior, and failure modes.
- Avoid changing product defaults from anecdotes. Promote a prompt/tool/context
  profile only after it improves the relevant model lane consistently.

## Model Lanes

### 1. Frontier Models

Use this lane to evaluate minicode as a serious general-purpose coding agent
when the model is already highly capable.

Candidate models:

- `openai/gpt-5.4`
- latest Claude Sonnet or Opus available through Anthropic or OpenRouter
- latest Gemini Pro or Flash model with stable tool support

Primary question:

Does minicode solve realistic coding tasks efficiently when the model can use
large context and reason well?

Expected benchmark emphasis:

- CCBench JS/TS full public subset for fast iteration.
- SWE-bench Verified curated subsets for realistic Python bug fixing.
- Full SWE-bench Verified only after curated lanes are stable and cost is
  acceptable.

### 2. Leading Open-Source Hosted Models

Use this lane for top open-source/open-weight models hosted behind OpenRouter or
similar providers. These may be strong enough for advanced benchmarks but can
have different tool-use behavior than frontier closed models.

Candidate models:

- Moonshot Kimi, for example `moonshotai/kimi-k2.6`
- GLM, for example the latest GLM 4.6-class coding/chat model available
- MiniMax, for example the latest MiniMax reasoning/coding model available
- DeepSeek coding/reasoning models when tool support is stable

Primary question:

Can minicode make leading open-source models competitive on realistic coding
benchmarks, and what prompt/tool profile prevents under-action or tool loops?

Expected benchmark emphasis:

- CCBench JS/TS full public subset.
- SWE-bench curated subsets only for models that show reliable edit/test loops.
- ts-bench as a lighter signal for basic coding competence, while recognizing it
  does not stress structured code navigation much.

### 3. Local-Sized Model Proxies

Use this lane for OpenRouter-hosted models that are commonly run locally, or are
similar in size/capability to models a user might run through Ollama or LM
Studio.

Candidate models:

- Qwen, for example Qwen3 14B or 32B variants
- GLM local-sized variants when available
- Gemma 4 local-sized variants when available
- Other 7B-34B coding/chat models with tool support

Primary question:

Does minicode's structured context help smaller/context-limited models do better
than plain file/search workflows?

Expected benchmark emphasis:

- ts-bench for lightweight coding-task signal.
- Small curated CCBench slices for codebase-navigation signal.
- Avoid full SWE-bench early; failures will often measure raw model limits more
  than harness quality.

## Benchmark Surfaces

### ts-bench

Best for:

- Fast local/open-source model smoke tests.
- Measuring basic edit/generation ability.
- Comparing model competence at low cost.

Limitations:

- Many tasks start from a blank or tiny codebase.
- Specialized tools and code-map variants are less meaningful because there may
  be little existing structure to index.

Recommended use:

- Use as the first local-sized model gate.
- Do not use ts-bench alone to evaluate structural-context claims.

### CCBench

Best for:

- Realistic JS/TS agentic tasks with existing code.
- Testing search, file reads, edits, command execution, and tool-use behavior.
- Fast-ish full-lane iteration compared with SWE-bench.

Recommended use:

- Frontier and leading open-source full JS/TS subset.
- Local-sized curated slices, selected from tasks with enough existing code to
  make context tools relevant.

### SWE-bench Verified

Best for:

- Real Python bug fixing against real repositories.
- Frontier-model harness quality.
- Python plugin and graph-tool validation under realistic codebases.

Recommended use:

- Start with curated subsets by repository family, for example Django, Sphinx,
  Requests, Astropy, Scikit-learn.
- Exclude or annotate known problematic/oracle-failing tasks.
- Run the full 500-task suite only after subset runs justify the cost.

## Experiment Knobs

Use benchmark-layer variants first. Do not change product defaults until a
variant proves itself in the target lane.

### Prompt Profile

- `current`: current product system prompt and benchmark suffix.
- `frontier-soft`: less forceful structural-tool guidance; lets frontier models
  choose broader file reads when useful.
- `local-structured`: stronger guidance toward code map, `read_symbol`,
  `get_dependencies`, and `find_references`.
- `action-loop`: stronger benchmark suffix emphasizing inspect, edit, run tests,
  and iterate instead of stopping after analysis.
- `loop-recovery`: stronger instruction after repeated tool calls or repeated
  no-edit behavior.

### Code Map Profile

- `none`: no code map in the system prompt.
- `current`: existing compact code map budget.
- `large`: larger code map for models with large context windows.
- `searchable-only`: omit code map from the prompt, but keep `search_code_map`
  available.

Questions to answer:

- Do frontier models benefit from larger code maps, or do they prefer file/search
  discovery?
- Do local-sized models need a visible code map to orient themselves?
- Does a large code map increase cost without improving pass rate?

### Tool Availability

- `all-tools`: current full tool set.
- `file-search-only`: disable specialized graph tools; keep read/search/edit/run.
- `no-code-map-tool`: keep `read_symbol`/dependencies but disable
  `search_code_map`.
- `structural-only-emphasis`: keep all tools but order/descriptions favor
  structural reads.

Questions to answer:

- Are specialized tools improving pass rate or only reducing tokens?
- Are models ignoring structural tools because descriptions are weak?
- Are models overusing structural tools and missing broad file context?

### Context and Output Budgets

- `maxContextTokens`: test `32k`, `64k`, `100k`, and model-specific large limits.
- `maxToolOutputChars`: test smaller output for local-sized models and larger
  output for frontier models.
- Code map token budget: current, large, and none.

Questions to answer:

- Does more context improve pass rate or just cost?
- Are failures caused by missing context, wrong context, or poor action loops?

### Runtime Loop

- `maxSteps`: default vs higher. Current evidence suggests this is usually not
  the first bottleneck, but it should remain measurable.
- `modelTimeoutSeconds`: start-response timeout by model family.
- command timeout and test retry behavior.
- repeated-tool-call threshold and recovery message.

Questions to answer:

- Do models fail by running out of steps, or by choosing the wrong actions?
- Do local-sized models need stronger loop recovery?
- Are test commands run often enough after edits?

## Metrics

Always record:

- pass rate / reward
- runtime
- input tokens
- output tokens
- total tool calls
- specialized structural tool calls
- file reads
- searches
- shell commands
- mutations
- repeated tool-call stops
- skipped repeated calls
- changed files

Derived metrics:

- specialized-tool ratio
- file-read ratio
- command-per-mutation ratio
- mutations per task
- no-edit failure rate
- token cost per solved task
- runtime per solved task

Failure categories:

- `no-edit`: model inspected but made no mutation.
- `wrong-file`: edits happened in irrelevant files.
- `partial-fix`: directionally right but incomplete.
- `bad-test-loop`: failed to run tests or misinterpreted failures.
- `tool-loop`: repeated calls without progress.
- `context-miss`: did not inspect the needed code.
- `over-context`: too much context appears to distract or raise cost.
- `insufficient-model`: task is beyond the model's reliable capability.
- `infra/verifier`: benchmark environment or verifier issue.

## Testing Matrix

### Phase 1: Baseline Stabilization

Run enough to establish reliable baselines without large spend.

| Lane | Models | Benchmarks | Variants |
| --- | --- | --- | --- |
| Frontier | `openai/gpt-5.4`, latest Claude | CCBench JS/TS full, SWE-bench Django 3-10 | current/all-tools/current-code-map |
| Leading open-source | Kimi, GLM, MiniMax | CCBench JS/TS full | current/all-tools/current-code-map |
| Local-sized | Qwen3 14B/32B, Gemma, GLM local-sized | ts-bench, CCBench 2-5 curated | current/all-tools/current-code-map |

Exit criteria:

- Each lane has at least one successful end-to-end run.
- Results include tool-usage and failure-category summaries.
- Known benchmark infra issues are annotated.

### Phase 2: Context and Code Map Ablation

Keep model and benchmark fixed; vary only code map/context.

| Lane | Benchmark | Variants |
| --- | --- | --- |
| Frontier | CCBench full | no code map, current code map, large code map, searchable-only |
| Frontier | SWE-bench curated | no code map, current code map, large code map |
| Leading open-source | CCBench full | no code map, current code map, large code map |
| Local-sized | CCBench curated | no code map, current code map, large code map if context allows |

Exit criteria:

- Identify whether visible code maps help pass rate, reduce tokens, or hurt
  performance per lane.
- Decide whether large-code-map support is worth implementing as a first-class
  benchmark profile.

### Phase 3: Tool Availability Ablation

Keep code map/context fixed; vary tools.

| Lane | Benchmark | Variants |
| --- | --- | --- |
| Frontier | CCBench full | all-tools, file-search-only, searchable-only |
| Frontier | SWE-bench curated | all-tools, file-search-only |
| Leading open-source | CCBench full | all-tools, file-search-only, structural-emphasis |
| Local-sized | CCBench curated | all-tools, file-search-only, structural-emphasis |

Exit criteria:

- Quantify whether specialized tools improve pass rate or token efficiency.
- Detect whether any model family overuses or ignores specialized tools.

### Phase 4: Prompt Profile Ablation

Only run this after baseline/context/tool data is available.

| Lane | Prompt Profiles |
| --- | --- |
| Frontier | current, frontier-soft, action-loop |
| Leading open-source | current, action-loop, structural-emphasis |
| Local-sized | current, local-structured, action-loop, loop-recovery |

Exit criteria:

- Promote prompt changes only within the model lane where they consistently win.
- If profiles diverge, introduce explicit benchmark/product profiles rather than
  one global default.

### Phase 5: Larger Runs

- Frontier: 25-50 SWE-bench curated tasks, then full SWE-bench Verified if cost
  and reliability justify it.
- Leading open-source: CCBench full repeated runs and 5-10 SWE-bench curated
  tasks for models that show reliable edit/test loops.
- Local-sized: repeated ts-bench and curated CCBench slices; only attempt
  SWE-bench if the model reliably edits/tests on CCBench.

## Optimization Candidates

Do not implement these until the benchmark data points to them.

- Add benchmark profile config for prompt, tool availability, and code-map size.
- Add a large-code-map mode for high-context frontier models.
- Add a no-code-map/searchable-only mode.
- Add a file-search-only tool profile for ablations.
- Add a local-structured prompt profile.
- Add a frontier-soft prompt profile.
- Add stronger no-edit recovery if a model repeatedly stops after analysis.
- Add stronger repeated-tool-call recovery or adaptive tool suppression.
- Improve Python structural tool descriptions if SWE-bench uses very few
  specialized tools.
- Add richer failure tagging to benchmark result parsing.

## Reporting Format

Each run should add a row to the benchmark-specific `RESULTS.md` and, for larger
experiments, a short breakdown with:

- model and provider
- benchmark scope
- variant/profile
- pass rate
- runtime
- token usage
- tool-usage aggregate
- notable failure categories
- job path
- caveats

Example variant name:

```text
frontier-gpt-5.4-ccbench-current-codemap-alltools
```

## Decision Rules

- A product default should not change based on one model or one tiny task slice.
- A frontier-only win should become a frontier profile, not a global default.
- A local-sized win should become a local/open-source profile, not a frontier
  default.
- Prefer simple defaults unless a benchmarked profile wins clearly.
- Treat no-edit and tool-loop rates as harness problems even when pass rate is
  low; those are often fixable without changing the model.
