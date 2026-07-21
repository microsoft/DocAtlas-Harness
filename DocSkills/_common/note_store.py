"""Portable NoteStore — append-only timeline of action + analysis entries.

Notes have a canonical JSON representation so they travel cleanly through
the session file.

Two entry kinds:
  * "action"   — rule-appended after a search tool call (query + observation)
  * "analysis" — model-appended via the Note skill (found + plan + evidence)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterable


# ── Note entry ──────────────────────────────────────────────────────────────


@dataclass
class NoteEntry:
    step: int
    kind: str                     # "action" | "analysis"
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: time.strftime("%H:%M:%S"))

    # ---- serialization ----

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "kind": self.kind,
            "timestamp": self.timestamp,
            "data": self.data,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "NoteEntry":
        return cls(
            step=int(d.get("step", 0)),
            kind=str(d.get("kind", "analysis")),
            data=dict(d.get("data") or {}),
            timestamp=str(d.get("timestamp") or time.strftime("%H:%M:%S")),
        )

    # ---- rendering ----

    def render(self) -> str:
        if self.kind == "action":
            action = self.data.get("action", "")
            query = self.data.get("query", "")
            observation = self.data.get("observation", "")
            lines = [f"[Step {self.step}] {self.timestamp} | ACTION: {action}"]
            if query:
                lines.append(f"  Query: {query}")
            if observation:
                lines.append(f"  Result: {_shorten(observation, 500)}")
            return "\n".join(lines)

        # analysis
        found = self.data.get("found", "")
        plan = self.data.get("plan", "")
        evidence = self.data.get("evidence", []) or []
        note_id = self.data.get("note_id", 0)
        lines = [f"[Step {self.step}] {self.timestamp} | ANALYSIS note#{note_id}"]
        if found:
            lines.append(f"  Found: {found}")
        if evidence:
            lines.append(f"  Evidence ({len(evidence)} items):")
            for i, ev in enumerate(evidence, 1):
                if not isinstance(ev, dict):
                    lines.append(f"    [{i}] {ev}")
                    continue
                ev_type = ev.get("type", "text")
                source = ev.get("source", "unknown")
                if ev_type == "image":
                    filename = ev.get("filename", "")
                    lines.append(f"    [{i}] Figure from {source}: {filename}")
                else:
                    content = str(ev.get("content", ""))
                    label = "Table" if ev_type == "table" else "Text"
                    preview = content[:200] + "…" if len(content) > 200 else content
                    lines.append(f"    [{i}] {label} from {source}: {preview}")
        if plan:
            lines.append(f"  Plan: {plan}")
        return "\n".join(lines)


# ── Note store ──────────────────────────────────────────────────────────────


class NoteStore:
    """Append-only timeline. JSON-serializable."""

    def __init__(self, question: str = ""):
        self._entries: list[NoteEntry] = []
        self._step: int = 0
        self._tool_call_count: int = 0
        self.question: str = question

    # ---- serialization ----

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "step": self._step,
            "tool_call_count": self._tool_call_count,
            "entries": [e.to_dict() for e in self._entries],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "NoteStore":
        d = d or {}
        store = cls(question=str(d.get("question", "")))
        store._step = int(d.get("step", 0))
        store._tool_call_count = int(d.get("tool_call_count", 0))
        store._entries = [NoteEntry.from_dict(e) for e in (d.get("entries") or [])]
        return store

    # ---- mutations ----

    def add_action(
        self, action: str, query: str = "", observation: str = ""
    ) -> NoteEntry:
        self._step += 1
        entry = NoteEntry(
            step=self._step,
            kind="action",
            data={"action": action, "query": query, "observation": observation},
        )
        self._entries.append(entry)
        return entry

    def add_analysis(
        self,
        found: str = "",
        plan: str = "",
        evidence: list[dict[str, Any]] | None = None,
        trace: dict[str, Any] | None = None,
    ) -> NoteEntry:
        self._step += 1
        note_id = self.analysis_count + 1
        entry = NoteEntry(
            step=self._step,
            kind="analysis",
            data={
                "note_id": note_id,
                "found": found,
                "plan": plan,
                "evidence": list(evidence or []),
                "trace": dict(trace or {}),
            },
        )
        self._entries.append(entry)
        return entry

    def tick_tool_call(self) -> None:
        self._tool_call_count += 1

    def clear(self) -> None:
        self._entries.clear()
        self._step = 0
        self._tool_call_count = 0
        self.question = ""

    # ---- reads ----

    @property
    def entries(self) -> list[NoteEntry]:
        return list(self._entries)

    @property
    def analysis_count(self) -> int:
        return sum(1 for e in self._entries if e.kind == "analysis")

    @property
    def tool_call_count(self) -> int:
        return self._tool_call_count

    def analysis_entries(self) -> list[NoteEntry]:
        return [e for e in self._entries if e.kind == "analysis"]

    def find_analysis(self, note_id: int) -> NoteEntry | None:
        for e in self._entries:
            if e.kind == "analysis" and int(e.data.get("note_id", 0)) == note_id:
                return e
        return None

    def build_note_card(self, entry: NoteEntry) -> dict[str, Any]:
        data = entry.data
        found = str(data.get("found", "") or "").strip()
        evidence = data.get("evidence", []) or []
        sources: list[str] = []
        page_refs: set[int] = set()
        for ev in evidence:
            if not isinstance(ev, dict):
                continue
            source = str(ev.get("source", "") or "").strip()
            if source and source not in sources:
                sources.append(source)
            page_refs.update(_extract_page_refs(source))
        if not page_refs:
            page_refs.update(_extract_page_refs(found))
        return {
            "note_id": int(data.get("note_id", 0)),
            "step": int(entry.step),
            "found": found,
            "page_refs": sorted(page_refs),
            "sources": sources,
        }


# ── helpers ────────────────────────────────────────────────────────────────


def _shorten(text: str, max_len: int = 500) -> str:
    text = str(text).strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


_PAGE_RE = re.compile(r"[Pp](?:age)?\.?\s*(\d+)")
_RANGE_RE = re.compile(r"[Pp]ages?\s*(\d+)\s*[-–]\s*(\d+)")


def _extract_page_refs(text: str) -> set[int]:
    pages: set[int] = set()
    for m in _PAGE_RE.finditer(text or ""):
        pages.add(int(m.group(1)))
    for m in _RANGE_RE.finditer(text or ""):
        start, end = int(m.group(1)), int(m.group(2))
        if 0 <= end - start <= 50:
            pages.update(range(start, end + 1))
    return pages


__all__ = ["NoteEntry", "NoteStore"]
