"""PlainRenderer — dependency-free progress output wired to LoopCallbacks.

Replaces the former Rich TUI: prints turn markers, tool calls, reasoning
summaries, and run stats to stderr as plain text. The final answer is written
to stdout by the caller (``cmd_chat``), not here, so it stays pipe-friendly.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .callbacks import LoopCallbacks


def _format_args(args: dict) -> str:
    """Compact one-line display of tool-call arguments."""
    parts = []
    for k, v in args.items():
        if isinstance(v, str):
            s = v if len(v) <= 40 else v[:37] + "..."
            parts.append(f"{k}={s!r}")
        elif isinstance(v, (list, dict)):
            raw = json.dumps(v, ensure_ascii=False)
            if len(raw) > 40:
                raw = raw[:37] + "..."
            parts.append(f"{k}={raw}")
        else:
            parts.append(f"{k}={v}")
    return ", ".join(parts)


class PlainRenderer:
    """Plain-text renderer that plugs into AgentLoop via LoopCallbacks."""

    def __init__(self, session: Any) -> None:
        self.session = session

    def as_callbacks(self) -> LoopCallbacks:
        return LoopCallbacks(
            on_turn_start=self.on_turn_start,
            on_tool_call=self.on_tool_call,
            on_tool_result=self.on_tool_result,
            on_turn_end=self.on_turn_end,
            on_reasoning=self.on_reasoning,
        )

    def on_turn_start(self, turn_num: int) -> None:
        sys.stderr.write(f"\n──── Turn {turn_num} ────\n")

    def on_reasoning(self, summary: str) -> None:
        lines = summary.splitlines()
        if len(lines) > 6:
            summary = "\n".join(lines[:6]) + "\n…"
        sys.stderr.write(f"  [reasoning] {summary}\n")

    def on_tool_call(self, call_id: str, name: str, args: dict) -> None:
        arg_str = _format_args(args) if args else ""
        sys.stderr.write(f"  -> {name}({arg_str})\n")

    def on_tool_result(
        self, call_id: str, name: str, text: str, elapsed: float, img_count: int
    ) -> None:
        extra = f"  {img_count} image(s)" if img_count else ""
        sys.stderr.write(f"     {elapsed:.1f}s{extra}\n")

    def on_turn_end(self, turn_event: Any) -> None:
        archived = getattr(turn_event, "archived_count", 0)
        if archived:
            sys.stderr.write(f"     archived {archived} tool output(s)\n")
        if hasattr(self.session, "refresh_from_disk"):
            try:
                self.session.refresh_from_disk()
            except Exception:  # noqa: BLE001
                pass

    def print_stats(self, result: Any) -> None:
        """Print a one-line run summary after the answer."""
        turns = getattr(result, "turns", [])
        total_calls = sum(len(getattr(t, "tool_calls", [])) for t in turns)
        inp = getattr(result, "total_input_tokens", 0)
        out = getattr(result, "total_output_tokens", 0)
        reas = getattr(result, "total_reasoning_tokens", 0)
        elapsed = getattr(result, "total_elapsed_s", 0)
        sys.stderr.write(
            f"\n  {len(turns)} turns · {total_calls} tool calls · "
            f"{inp:,} input · {out:,} output · {reas:,} reasoning · {elapsed:.1f}s\n"
        )
        err = getattr(result, "error", None)
        if err:
            sys.stderr.write(f"  ! {err}\n")
