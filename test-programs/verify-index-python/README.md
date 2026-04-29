# Verify Index (Python) Test Program

A minimal Python project mirroring `test-programs/verify-index/` for verifying minicode's Python plugin.

## Structure

```
src/
  index.py      — Entry point; main() instantiates Processor and calls run()
  types.py      — Task, Result dataclasses + TaskRunner Protocol
  processor.py  — class Processor(TaskRunner); run() calls parse_and_process()
  parser.py     — parse(), process(), parse_and_process()
```
