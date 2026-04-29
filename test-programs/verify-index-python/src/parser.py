"""Parser module: parse, process, parse_and_process."""
import uuid

from .types import Result, Task


def parse(input: str) -> Task:
    """Parse raw input into a Task.

    Referenced by Processor.run().
    """
    return Task(id=str(uuid.uuid4()), input=input.strip())


def process(task: Task) -> Result:
    """Process a Task and produce a Result.

    Called by parse_and_process().
    """
    return Result(success=True, output=f"Processed: {task.input}")


def parse_and_process(input: str) -> Result:
    """Combine parse and process. Used by Processor."""
    task = parse(input)
    return process(task)
