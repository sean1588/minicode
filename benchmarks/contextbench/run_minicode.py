"""Drive minicode through ContextBench tasks via docker.

Thin runner that wraps the SWE-bench Docker images ContextBench already builds
on. For each task we pull the image, install minicode inside the container via
the host-served tarball, run `minicode benchmark run` with the problem
statement as the prompt, and persist the trajectory + diff back to the host so
ContextBench's offline evaluator can score it.

Usage:
    python3 benchmarks/contextbench/run_minicode.py \\
        --dataset /path/to/contextbench_verified.parquet \\
        --tarball-url http://172.17.0.1:18081/minicode.tgz \\
        --out /tmp/minicode-contextbench-runs \\
        --limit 3

We don't replicate the niceties of MiniSWE-Agent's runner here (parallel docker
pools, progress bars, retry policies). This is intentionally minimal so the
smoke test cycle is short and the integration surface is small.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

# Mirrors mini-SWE-Agent's image name derivation (see
# agent-frameworks/mini-swe-agent/.../run/extra/swebench.py:get_swebench_docker_image_name).
# Docker doesn't permit double underscores, so SWE-bench substitutes _1776_.
DOCKER_IMAGE_TEMPLATE = "docker.io/swebench/sweb.eval.x86_64.{slug}:latest"


@dataclass
class Task:
    instance_id: str
    original_inst_id: str
    repo: str
    base_commit: str
    problem_statement: str
    test_patch: str
    language: str
    image: str

    @classmethod
    def from_row(cls, row: dict) -> "Task":
        original = row.get("original_inst_id") or row["instance_id"]
        slug = original.replace("__", "_1776_").lower()
        return cls(
            instance_id=row["instance_id"],
            original_inst_id=original,
            repo=row.get("repo", ""),
            base_commit=row.get("base_commit", ""),
            problem_statement=row["problem_statement"],
            test_patch=row.get("test_patch", "") or "",
            language=row.get("language", ""),
            image=DOCKER_IMAGE_TEMPLATE.format(slug=slug),
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run minicode against ContextBench tasks.")
    parser.add_argument(
        "--dataset",
        required=True,
        help="Path to contextbench_verified.parquet (or compatible).",
    )
    parser.add_argument(
        "--tarball-url",
        required=True,
        help="HTTP URL the container will pull the minicode npm tarball from "
        "(e.g. http://172.17.0.1:18081/minicode.tgz).",
    )
    parser.add_argument("--out", required=True, help="Output directory (one subdir per instance).")
    parser.add_argument("--model", default="google/gemini-3-flash-preview")
    parser.add_argument("--provider", default="openai-compatible")
    parser.add_argument("--base-url", default="https://openrouter.ai/api/v1")
    parser.add_argument("--limit", type=int, default=0, help="Run at most this many tasks (0 = no limit).")
    parser.add_argument(
        "--instances",
        default="",
        help="Comma-separated instance_id or original_inst_id list. Overrides --limit when set.",
    )
    parser.add_argument("--max-steps", type=int, default=150)
    parser.add_argument("--max-tokens", type=int, default=32000)
    parser.add_argument("--max-context-tokens", type=int, default=100000)
    parser.add_argument("--model-timeout-seconds", type=int, default=240)
    parser.add_argument(
        "--container-timeout",
        type=int,
        default=1800,
        help="Hard wall-clock per task (seconds).",
    )
    parser.add_argument(
        "--keep-images",
        action="store_true",
        help="Don't `docker rmi` the image after each task.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print what would run; don't pull or execute.")
    return parser.parse_args()


def select_tasks(df: pd.DataFrame, args: argparse.Namespace) -> list[Task]:
    if args.instances.strip():
        wanted = {s.strip() for s in args.instances.split(",") if s.strip()}
        mask = df["instance_id"].isin(wanted) | df["original_inst_id"].isin(wanted)
        rows = df[mask]
    else:
        rows = df if args.limit == 0 else df.head(args.limit)
    return [Task.from_row(row.to_dict()) for _, row in rows.iterrows()]


def pull_image(image: str) -> bool:
    print(f"  → pulling {image}", flush=True)
    res = subprocess.run(["docker", "pull", image], check=False, text=True, capture_output=True)
    if res.returncode != 0:
        print(f"  ✗ docker pull failed:\n{res.stderr.strip()[:500]}", file=sys.stderr)
        return False
    return True


def build_container_script(task: Task, args: argparse.Namespace) -> str:
    """Bash script that runs inside the container for one task.

    1. Drop the problem statement + test_patch via heredocs so issue bodies
       with backticks/quotes don't bite us on shell escaping.
    2. Apply test_patch so minicode sees the failing tests it must fix.
    3. Ensure node 22 + npm are present, then install the minicode tarball.
    4. Run `minicode benchmark run` with --contextbench-trajectory and
       --diff-out so all artifacts land in the bind-mounted /out.
    """
    problem_eof = "PROBLEM_STATEMENT_EOF"
    patch_eof = "TEST_PATCH_EOF"
    return f"""set -euo pipefail
mkdir -p /out

cat > /tmp/problem_statement.txt <<'{problem_eof}'
{task.problem_statement}
{problem_eof}

cat > /tmp/test.patch <<'{patch_eof}'
{task.test_patch}
{patch_eof}

WS=/testbed
if [ ! -d "$WS" ]; then
  WS=$(ls -d /home/*/ 2>/dev/null | head -1 || echo /workspace)
fi
cd "$WS"

if [ -s /tmp/test.patch ]; then
  git apply --whitespace=nowarn /tmp/test.patch \\
    || git apply --reject --whitespace=nowarn /tmp/test.patch \\
    || true
fi

if ! command -v node >/dev/null 2>&1 \\
   || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null
fi

# Many SWE-bench images (especially django ones) activate a conda env whose
# `python` is 3.6, which breaks node-gyp's tree-sitter build because gyp's
# python source uses walrus operator (3.8+). Point npm at the system python
# 3.10 if available — it's present on every SWE-bench image we've seen so far.
NPM_PY=""
for cand in /usr/bin/python3.10 /usr/bin/python3.11 /usr/bin/python3.12 /usr/bin/python3.9; do
  if [ -x "$cand" ]; then NPM_PY="$cand"; break; fi
done

echo "Installing minicode from {args.tarball_url} (npm_config_python=$NPM_PY)"
# Capture full npm output to /out/npm-install.log so failures (tree-sitter
# native build, etc.) are inspectable from the host without re-running.
if ! npm_config_python="$NPM_PY" npm install -g "{args.tarball_url}" \
    > /out/npm-install.log 2>&1; then
  echo "npm install failed — see /out/npm-install.log (tail below):"
  tail -40 /out/npm-install.log
  exit 1
fi

minicode benchmark run \\
  --workspace-root "$WS" \\
  --provider "{args.provider}" \\
  --base-url "{args.base_url}" \\
  --model "{args.model}" \\
  --out /out/result.json \\
  --diff-out /out/minicode.patch \\
  --contextbench-trajectory "/out/{task.instance_id}.traj.json" \\
  --contextbench-image "{task.image}" \\
  --prompt-file /tmp/problem_statement.txt 2>&1 | tee /out/minicode.stdout
"""


def write_task_outputs(out_dir: Path, task: Task, container_result: subprocess.CompletedProcess) -> None:
    """Surface container stdout/stderr to the host. result.json,
    <instance_id>.traj.json, and minicode.patch are already on the host via
    the volume mount.
    """
    (out_dir / "container.stdout").write_text(container_result.stdout or "")
    (out_dir / "container.stderr").write_text(container_result.stderr or "")
    (out_dir / "task.json").write_text(json.dumps(
        {
            "instance_id": task.instance_id,
            "original_inst_id": task.original_inst_id,
            "repo": task.repo,
            "base_commit": task.base_commit,
            "language": task.language,
            "image": task.image,
            "returncode": container_result.returncode,
        },
        indent=2,
    ))


def run_task(task: Task, args: argparse.Namespace, out_root: Path) -> tuple[bool, str]:
    out_dir = out_root / task.instance_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if not pull_image(task.image):
        return False, "image pull failed"

    # minicode reads bare env names (MODEL_TIMEOUT_SECONDS etc.) — the
    # MINICODE_BENCHMARK_* prefix only applies inside harbor's adapter,
    # which has its own translation step. Pass through the unprefixed
    # names directly.
    env = {
        "MAX_STEPS": str(args.max_steps),
        "MAX_TOKENS": str(args.max_tokens),
        "MAX_CONTEXT_TOKENS": str(args.max_context_tokens),
        "MODEL_TIMEOUT_SECONDS": str(args.model_timeout_seconds),
        "CONFIRM_DESTRUCTIVE": "false",
    }
    for key in ("OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        value = os.environ.get(key)
        if value:
            env[key] = value

    script = build_container_script(task, args)
    env_args: list[str] = []
    for key, value in env.items():
        env_args.extend(["-e", f"{key}={value}"])
    cmd = [
        "docker", "run", "--rm",
        "--network", "host",
        "-v", f"{out_dir.resolve()}:/out",
        *env_args,
        task.image,
        "bash", "-lc", script,
    ]
    print(f"  → running container ({task.instance_id})", flush=True)
    try:
        result = subprocess.run(cmd, check=False, text=True, capture_output=True, timeout=args.container_timeout)
    except subprocess.TimeoutExpired as exc:
        write_task_outputs(
            out_dir,
            task,
            subprocess.CompletedProcess(cmd, 124, exc.stdout or "", exc.stderr or ""),
        )
        return False, f"timeout after {args.container_timeout}s"
    write_task_outputs(out_dir, task, result)

    if not args.keep_images:
        subprocess.run(["docker", "rmi", task.image], check=False, capture_output=True)

    if result.returncode != 0:
        return False, f"container exit {result.returncode}; see container.stderr"
    trajectory = out_dir / f"{task.instance_id}.traj.json"
    if not trajectory.exists():
        return False, f"container produced no {task.instance_id}.traj.json"
    return True, str(trajectory)


def main() -> int:
    args = parse_args()
    df = pd.read_parquet(args.dataset)
    tasks = select_tasks(df, args)
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    if not tasks:
        print("No matching tasks. Check --instances / --limit.", file=sys.stderr)
        return 2

    summary: list[dict] = []
    overall_start = time.time()

    for index, task in enumerate(tasks, start=1):
        print(f"[{index}/{len(tasks)}] {task.instance_id} ({task.language})", flush=True)
        if args.dry_run:
            print(f"  (dry-run) image: {task.image}; problem_statement: {len(task.problem_statement)} chars")
            summary.append({"instance_id": task.instance_id, "status": "dry-run"})
            continue
        started = time.time()
        ok, detail = run_task(task, args, out_root)
        elapsed = time.time() - started
        summary.append(
            {
                "instance_id": task.instance_id,
                "ok": ok,
                "detail": detail,
                "elapsed_sec": round(elapsed, 1),
            }
        )
        marker = "✓" if ok else "✗"
        print(f"  {marker} {detail} ({elapsed:.1f}s)", flush=True)

    overall = time.time() - overall_start
    passed = sum(1 for s in summary if s.get("ok"))
    print(f"\nDone. {passed}/{len(tasks)} tasks produced a trajectory.")
    print(f"Total wall time: {overall:.1f}s")
    (out_root / "summary.json").write_text(json.dumps(summary, indent=2))
    return 0 if passed == len(tasks) else 1


if __name__ == "__main__":
    sys.exit(main())
