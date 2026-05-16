# ContextBench adapter

Drives minicode through [ContextBench](https://github.com/EuniAI/ContextBench)
tasks by reusing the SWE-bench Docker images each task ships with.

## What this is

- `run_minicode.py` — minimal Python driver. For each task: pull the docker
  image, install minicode inside the container from a host-served tarball,
  run `minicode benchmark run` with the problem statement, and persist the
  trajectory + diff + result.json back to the host.

- The TS-side trajectory emitter (`src/cli/contextbench-trajectory.ts`)
  produces `.traj.json` files in the MiniSWE-Agent format ContextBench's
  extractor already understands — graph-tool reads like `read_symbol` /
  `find_references` get resolved through the project index into file+line
  spans inside `<explore_context>` blocks.

## Smoke test workflow

1. Build + serve the minicode tarball on the host:

   ```bash
   npm pack --pack-destination /tmp
   cp /tmp/sean.holung-minicode-*.tgz /tmp/sean.holung-minicode-contextbench.tgz
   # Reuse the same HTTP server we use for CCBench runs.
   ```

2. Run on a small subset:

   ```bash
   OPENROUTER_API_KEY=… python3 benchmarks/contextbench/run_minicode.py \
     --dataset /tmp/ContextBench/data/contextbench_verified.parquet \
     --tarball-url http://172.17.0.1:18081/sean.holung-minicode-contextbench.tgz \
     --out /tmp/minicode-contextbench-smoke \
     --limit 3
   ```

3. Score the trajectories with ContextBench's evaluator:

   ```bash
   for traj in /tmp/minicode-contextbench-smoke/*/trajectory.traj.json; do
     PYTHONPATH=/tmp/ContextBench python3 -m contextbench.evaluate \
       --gold /tmp/ContextBench/data/contextbench_verified.parquet \
       --pred "$traj" \
       --out "${traj%/trajectory.traj.json}/score.jsonl"
   done
   ```

## What this driver does NOT do

- Doesn't parallelize. Run a 3-5 task smoke first; scale up after we know
  the trajectory format is sound.
- Doesn't retry failed pulls / container errors. Failures are surfaced via
  `summary.json` and per-instance `container.stderr`.
- Doesn't talk to the ContextBench leaderboard. Trajectories land on disk;
  evaluation is offline.

## Useful flags

- `--instances` accepts comma-separated `instance_id` or `original_inst_id`
  for replaying specific tasks.
- `--keep-images` skips `docker rmi` between tasks — useful when iterating
  on the same handful of instances.
- `--dry-run` prints the image name + problem-statement size per task
  without pulling or running anything.
