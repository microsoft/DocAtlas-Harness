"""MMLongBench-Doc batch evaluation task.

Drives the DocAtlas agent loop over the MMLongBench-Doc benchmark and
emits per-question records in the JSON shape
`scoring/score_mmlongbench_hybrid.py` expects, so that scorer can be reused
unmodified.
"""

from .runner import MMLongBenchTask

__all__ = ["MMLongBenchTask"]
