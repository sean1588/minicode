"""Processor implements TaskRunner; run() calls parse_and_process()."""
from .parser import parse_and_process
from .types import Result, Task, TaskRunner


class Processor(TaskRunner):
    """Processor wires parsing and processing together."""

    async def run(self, task: Task) -> Result:
        return parse_and_process(task.input)
