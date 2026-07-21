"""Task — base contract for runnable jobs on top of the harness kernel.

A `Task` plugs into `python -m harness <subcommand>`: it owns its argparse
surface and a `run(args) -> int` that drives the harness loop on some
batch of inputs (eval, synthesis, etc.). The kernel itself stays
task-agnostic.
"""

from __future__ import annotations

import argparse
from typing import Protocol


class Task(Protocol):
    name: str

    def add_arguments(self, parser: argparse.ArgumentParser) -> None: ...

    def run(self, args: argparse.Namespace) -> int: ...


__all__ = ["Task"]
