# SWE-bench Verified Results

This file records minicode runs against SWE-bench Verified through Harbor.

## Local Runs

| Date | Agent | Provider | Model | Scope | Score | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-04-30 | minicode | OpenRouter | `openai/gpt-5.4` | 3 Django tasks, current PR tarball | `66.7%` (`2/3`) | Curated smoke run through Harbor registry dataset. Runtime: `23m05s`. Exceptions: `0`. Job: `/tmp/minicode-swebench-jobs/gpt-5-4-swebench-django-smoke-3/result.json`. |
| 2026-04-30 | minicode | OpenRouter | `openai/gpt-5.4` | 1 default registry task, current PR tarball | `0%` (`0/1`) | End-to-end registry smoke selected `astropy__astropy-7606`, which Harbor's SWE-bench adapter README lists as a known problematic/oracle-failing task. Runtime: `5m29s`. Exceptions: `0`. Job: `/tmp/minicode-swebench-jobs/gpt-5-4-swebench-smoke-1/result.json`. |

## 2026-04-30 GPT-5.4 Django Smoke

This run used `openai/gpt-5.4` through OpenRouter with
`maxContextTokens=100000`, the current PR tarball, and Harbor's registered
`swebench-verified` dataset filtered to Django tasks.

| Task | Reward | Duration | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Specialized tools |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `django__django-11265` | `0.0` | `173s` | `25` | `0` | `8` | `7` | `6` | `3` | none |
| `django__django-12143` | `1.0` | `442s` | `51` | `0` | `15` | `13` | `18` | `4` | none |
| `django__django-16100` | `1.0` | `145s` | `22` | `1` | `6` | `9` | `2` | `4` | `search_code_map` `1` |

Aggregate tool usage:

- total tool calls: `98`
- specialized structural tool calls: `1` (`1.0%`)
- file reads: `29` (`29.6%`)
- searches: `29`
- shell commands: `26`
- mutations: `11`

Notes:

- The SWE-bench integration works end-to-end through Harbor's registry dataset:
  minicode installs in the task container, edits the repository, Harbor runs the
  verifier, and rewards are reported.
- The curated Django smoke scored `66.7%` (`2/3`) with zero infra exceptions.
- This lane used very few specialized structural tools. Python SWE-bench tasks
  may need prompt or tool-discovery tuning if we want the graph tooling to carry
  more of the workload.
- The default one-task smoke selected `astropy__astropy-7606`; Harbor documents
  that task as problematic even for oracle runs, so it should not be treated as
  a capability signal.
