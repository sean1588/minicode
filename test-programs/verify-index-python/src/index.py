"""Entry point: main() instantiates Processor and runs it."""
import asyncio

from .processor import Processor
from .types import Task


async def main() -> None:
    processor = Processor()
    task = Task(id="1", input="hello")
    result = await processor.run(task)
    print(result.output)


if __name__ == "__main__":
    asyncio.run(main())
