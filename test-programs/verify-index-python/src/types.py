"""Shared types for the Python verify-index test program.

Referenced by parse(), Processor, and process().
"""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Task:
    id: str
    input: str


@dataclass
class Result:
    success: bool
    output: str


class TaskRunner(Protocol):
    async def run(self, task: Task) -> Result: ...
