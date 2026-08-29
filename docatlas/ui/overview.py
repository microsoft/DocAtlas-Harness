"""Read-only, terminal-native overview of a DocAtlas investigation."""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from .plain_renderer import sanitize_terminal_text
from .terminal import (
    KEY_BACKSPACE,
    KEY_CTRL_A,
    KEY_CTRL_C,
    KEY_CTRL_D,
    KEY_CTRL_E,
    KEY_CTRL_U,
    KEY_DOWN,
    KEY_ENTER,
    KEY_ESCAPE,
    KEY_LEFT,
    KEY_PAGE_DOWN,
    KEY_PAGE_UP,
    KEY_RIGHT,
    KEY_SHIFT_TAB,
    KEY_SPACE,
    KEY_UP,
    CtrlCInterrupt,
    capture_typeahead,
    join_columns,
    read_terminal_key,
    terminal_size,
    truncate_display,
    wrap_display,
)

_MAX_TREE_NODES = 10_000
_MAX_TREE_DEPTH = 64
_MAX_CONVERSATION_TURNS = 200
_PAGE_RE = re.compile(r"[Pp](?:age)?\.?\s*(\d+)")
_PAGE_RANGE_RE = re.compile(r"[Pp]ages?\s*(\d+)\s*[-–]\s*(\d+)")
_TABS = ("Summary", "Findings", "Outline", "History")


def _safe_text(value: Any, *, multiline: bool = False, limit: int = 20_000) -> str:
    text = sanitize_terminal_text(str(value or ""), multiline=multiline).strip()
    if multiline:
        text = text.replace("\t", "  ")
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _safe_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return fallback


def _page_refs(*values: str) -> tuple[int, ...]:
    pages: set[int] = set()
    for value in values:
        for match in _PAGE_RE.finditer(value):
            pages.add(int(match.group(1)))
        for match in _PAGE_RANGE_RE.finditer(value):
            start, end = int(match.group(1)), int(match.group(2))
            if 0 < start <= end and end - start <= 100:
                pages.update(range(start, end + 1))
    return tuple(sorted(pages))


@dataclass(frozen=True)
class OverviewEvidence:
    kind: str
    source: str
    content: str
    filename: str = ""
    pages: tuple[int, ...] = ()


@dataclass(frozen=True)
class OverviewFinding:
    note_id: int
    step: int
    timestamp: str
    found: str
    plan: str
    evidence: tuple[OverviewEvidence, ...] = ()
    pages: tuple[int, ...] = ()


@dataclass(frozen=True)
class OverviewTurn:
    number: int
    question: str
    answer: str = ""


@dataclass(frozen=True)
class TreeFinding:
    page: str
    text: str


@dataclass(frozen=True)
class OverviewNode:
    key: str
    parent_key: str | None
    depth: int
    node_id: str
    title: str
    page_range: str
    summary: str
    findings: tuple[TreeFinding, ...]
    has_children: bool


@dataclass(frozen=True)
class OverviewSnapshot:
    session_id: str
    created_at: str
    documents: tuple[str, ...]
    current_question: str
    turns: tuple[OverviewTurn, ...]
    findings: tuple[OverviewFinding, ...]
    outline: tuple[OverviewNode, ...]
    search_count: int
    read_count: int

    @property
    def referenced_pages(self) -> tuple[int, ...]:
        return tuple(sorted({page for finding in self.findings for page in finding.pages}))

    @property
    def tree_finding_count(self) -> int:
        return sum(len(node.findings) for node in self.outline)


def _conversation_turns(workspace: dict[str, Any]) -> tuple[OverviewTurn, ...]:
    raw = workspace.get("conversation")
    if not isinstance(raw, list):
        return ()
    turns: list[OverviewTurn] = []
    for item in raw[-(_MAX_CONVERSATION_TURNS * 2) :]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).casefold()
        text = _safe_text(item.get("text"), multiline=True)
        if not text:
            continue
        if role == "user":
            turns.append(OverviewTurn(number=len(turns) + 1, question=text))
        elif role == "assistant" and turns and not turns[-1].answer:
            previous = turns[-1]
            turns[-1] = OverviewTurn(previous.number, previous.question, text)
    return tuple(turns[-_MAX_CONVERSATION_TURNS:])


def _analysis_findings(notes: Any) -> tuple[OverviewFinding, ...]:
    try:
        entries = notes.analysis_entries()
    except (AttributeError, TypeError):
        entries = []
    findings: list[OverviewFinding] = []
    for entry in entries:
        data = getattr(entry, "data", {})
        if not isinstance(data, dict):
            continue
        found = _safe_text(data.get("found"), multiline=True)
        plan = _safe_text(data.get("plan"), multiline=True)
        evidence_items: list[OverviewEvidence] = []
        raw_evidence_items = data.get("evidence")
        if not isinstance(raw_evidence_items, list):
            raw_evidence_items = []
        for raw_evidence in raw_evidence_items[:20]:
            if not isinstance(raw_evidence, dict):
                continue
            source = _safe_text(raw_evidence.get("source"))
            content = _safe_text(raw_evidence.get("content"), multiline=True)
            filename = _safe_text(raw_evidence.get("filename"))
            evidence_items.append(
                OverviewEvidence(
                    kind=_safe_text(raw_evidence.get("type") or "text"),
                    source=source,
                    content=content,
                    filename=filename,
                    pages=_page_refs(source, content),
                )
            )
        pages = _page_refs(
            found,
            *(evidence.source for evidence in evidence_items),
            *(evidence.content for evidence in evidence_items),
        )
        findings.append(
            OverviewFinding(
                note_id=_safe_int(data.get("note_id"), len(findings) + 1),
                step=_safe_int(getattr(entry, "step", 0)),
                timestamp=_safe_text(getattr(entry, "timestamp", "")),
                found=found,
                plan=plan,
                evidence=tuple(evidence_items),
                pages=pages,
            )
        )
    return tuple(findings)


def _tree_nodes(structure: Any) -> tuple[OverviewNode, ...]:
    roots = structure[:_MAX_TREE_NODES] if isinstance(structure, list) else [structure]
    stack: list[tuple[Any, int, tuple[int, ...], str | None]] = [
        (node, 0, (index,), None) for index, node in reversed(list(enumerate(roots)))
    ]
    nodes: list[OverviewNode] = []
    while stack and len(nodes) < _MAX_TREE_NODES:
        raw, depth, path, parent_key = stack.pop()
        if not isinstance(raw, dict) or depth > _MAX_TREE_DEPTH:
            continue
        key = ".".join(str(index) for index in path)
        start = raw.get("start_index")
        end = raw.get("end_index", start)
        if start is not None:
            start_text = _safe_text(start)
            end_text = _safe_text(end)
            page_range = (
                f"p.{start_text}" if start_text == end_text else f"pp.{start_text}–{end_text}"
            )
        elif raw.get("line_num") is not None:
            page_range = f"line {_safe_text(raw.get('line_num'))}"
        else:
            page_range = ""
        tree_findings: list[TreeFinding] = []
        raw_tree_findings = raw.get("page_findings")
        if not isinstance(raw_tree_findings, list):
            raw_tree_findings = []
        for finding in raw_tree_findings[:100]:
            if not isinstance(finding, dict):
                continue
            text = _safe_text(finding.get("observation_summary"), multiline=True)
            if text:
                tree_findings.append(
                    TreeFinding(page=_safe_text(finding.get("page_id") or "?"), text=text)
                )
        children_raw = raw.get("nodes")
        if isinstance(children_raw, dict):
            children = [children_raw]
        elif isinstance(children_raw, list):
            children = children_raw[:_MAX_TREE_NODES]
        else:
            children = []
        node = OverviewNode(
            key=key,
            parent_key=parent_key,
            depth=depth,
            node_id=_safe_text(raw.get("node_id") or "????"),
            title=_safe_text(raw.get("title") or raw.get("doc_name") or "Untitled"),
            page_range=page_range,
            summary=_safe_text(raw.get("summary") or raw.get("prefix_summary"), multiline=True),
            findings=tuple(tree_findings),
            has_children=bool(children),
        )
        nodes.append(node)
        if depth < _MAX_TREE_DEPTH:
            for index, child in reversed(list(enumerate(children))):
                stack.append((child, depth + 1, (*path, index), key))
    return tuple(nodes)


def build_overview_snapshot(
    session: Any, documents: list[Path] | tuple[Path, ...]
) -> OverviewSnapshot:
    """Build a defensive, immutable view of current session state."""
    workspace = getattr(session, "workspace", {})
    if not isinstance(workspace, dict):
        workspace = {}
    notes = getattr(session, "notes", None)
    current_question = _safe_text(getattr(notes, "question", ""), multiline=True)
    search_history = workspace.get("search_history")
    read_history = workspace.get("read_history")
    return OverviewSnapshot(
        session_id=_safe_text(getattr(session, "session_id", "")),
        created_at=_safe_text(getattr(session, "created_at", "")),
        documents=tuple(_safe_text(path.name) for path in documents),
        current_question=current_question,
        turns=_conversation_turns(workspace),
        findings=_analysis_findings(notes),
        outline=_tree_nodes(getattr(session, "tree", None))
        if getattr(session, "tree", None)
        else (),
        search_count=len(search_history) if isinstance(search_history, list) else 0,
        read_count=len(read_history) if isinstance(read_history, list) else 0,
    )


@dataclass(frozen=True)
class _ViewRow:
    text: str
    key: tuple[str, str] | None = None
    tone: str = "normal"


@dataclass
class OverviewModel:
    snapshot: OverviewSnapshot
    tab: int = 0
    cursors: dict[int, int] = field(default_factory=dict)
    scrolls: dict[int, int] = field(default_factory=dict)
    filters: dict[int, str] = field(default_factory=dict)
    expanded_findings: set[int] = field(default_factory=set)
    expanded_turns: set[int] = field(default_factory=set)
    collapsed_nodes: set[str] = field(default_factory=set)
    searching: bool = False
    status: str = ""

    def __post_init__(self) -> None:
        if not self.collapsed_nodes:
            self.collapsed_nodes = {
                node.key
                for node in self.snapshot.outline
                if node.has_children or node.findings or node.summary
            }

    @property
    def tab_name(self) -> str:
        return _TABS[self.tab]

    @property
    def filter_text(self) -> str:
        return self.filters.get(self.tab, "")

    def _finding_rows(self, findings: tuple[OverviewFinding, ...]) -> list[_ViewRow]:
        rows: list[_ViewRow] = []
        query = self.filter_text.casefold()
        for finding in reversed(findings):
            searchable = " ".join(
                [
                    finding.found,
                    finding.plan,
                    *(evidence.source for evidence in finding.evidence),
                    *(evidence.content for evidence in finding.evidence),
                ]
            ).casefold()
            if query and query not in searchable:
                continue
            pages = ",".join(str(page) for page in finding.pages)
            location = f" · p.{pages}" if pages else ""
            timestamp = f" · {finding.timestamp}" if finding.timestamp else ""
            summary = finding.found or finding.plan or "Empty note"
            rows.append(
                _ViewRow(
                    f"Note #{finding.note_id}{timestamp}{location}  {summary}",
                    ("finding", str(finding.note_id)),
                    "item",
                )
            )
            if finding.note_id not in self.expanded_findings:
                continue
            if finding.plan:
                rows.append(_ViewRow(f"  Next: {finding.plan}", tone="dim"))
            for index, evidence in enumerate(finding.evidence, 1):
                label = evidence.source or evidence.filename or evidence.kind
                rows.append(_ViewRow(f"  Evidence {index} · {label}", tone="label"))
                if evidence.content:
                    rows.append(_ViewRow(f"    {evidence.content}", tone="dim"))
        return rows

    def _summary_rows(self) -> list[_ViewRow]:
        snapshot = self.snapshot
        rows = [
            _ViewRow("Session", tone="heading"),
            _ViewRow(
                f"  Documents       {len(snapshot.documents)} · {', '.join(snapshot.documents)}"
            ),
            _ViewRow(f"  Questions       {len(snapshot.turns)}"),
            _ViewRow(f"  Analysis notes  {len(snapshot.findings)}"),
            _ViewRow(f"  Referenced pages {len(snapshot.referenced_pages)}"),
            _ViewRow(f"  Search / Read   {snapshot.search_count} / {snapshot.read_count}"),
            _ViewRow(f"  Tree findings   {snapshot.tree_finding_count}"),
        ]
        if snapshot.current_question:
            rows.extend(
                [
                    _ViewRow(""),
                    _ViewRow("Current question", tone="heading"),
                    _ViewRow(f"  {snapshot.current_question}"),
                ]
            )
        latest_plan = next(
            (finding.plan for finding in reversed(snapshot.findings) if finding.plan), ""
        )
        if latest_plan:
            rows.extend(
                [
                    _ViewRow(""),
                    _ViewRow("Next", tone="heading"),
                    _ViewRow(f"  {latest_plan}"),
                ]
            )
        rows.extend([_ViewRow(""), _ViewRow("Recent findings", tone="heading")])
        recent = tuple(snapshot.findings[-5:])
        if recent:
            rows.extend(_ViewRow(row.text, tone=row.tone) for row in self._finding_rows(recent))
        else:
            rows.append(_ViewRow("  No findings saved yet."))
        return rows

    def _outline_rows(self) -> list[_ViewRow]:
        rows: list[_ViewRow] = []
        query = self.filter_text.casefold()
        for node in self.snapshot.outline:
            path_parts = node.key.split(".")
            ancestors = (".".join(path_parts[:index]) for index in range(1, len(path_parts)))
            if not query and any(ancestor in self.collapsed_nodes for ancestor in ancestors):
                continue
            searchable = " ".join(
                [node.title, node.summary, *(finding.text for finding in node.findings)]
            ).casefold()
            if query and query not in searchable:
                continue
            expandable = node.has_children or bool(node.findings) or bool(node.summary)
            if expandable:
                marker = "▸" if node.key in self.collapsed_nodes else "▾"
            else:
                marker = "•"
            finding_badge = f" · {len(node.findings)} findings" if node.findings else ""
            page_range = f" · {node.page_range}" if node.page_range else ""
            indent = "  " * min(node.depth, 12)
            rows.append(
                _ViewRow(
                    f"{indent}{marker} {node.title}{page_range}{finding_badge}",
                    ("node", node.key),
                    "item",
                )
            )
            if node.key not in self.collapsed_nodes:
                if node.summary:
                    rows.append(_ViewRow(f"{indent}    {node.summary}", tone="dim"))
                for finding in node.findings:
                    rows.append(
                        _ViewRow(
                            f"{indent}    p.{finding.page}  {finding.text}",
                            tone="dim",
                        )
                    )
        return rows or [_ViewRow("  No document outline is available.")]

    def _history_rows(self) -> list[_ViewRow]:
        rows: list[_ViewRow] = []
        query = self.filter_text.casefold()
        for turn in reversed(self.snapshot.turns):
            if query and query not in f"{turn.question} {turn.answer}".casefold():
                continue
            rows.append(
                _ViewRow(
                    f"Question {turn.number}  {turn.question}",
                    ("turn", str(turn.number)),
                    "item",
                )
            )
            if turn.number in self.expanded_turns:
                rows.append(_ViewRow(f"  Q  {turn.question}", tone="label"))
                rows.append(_ViewRow(f"  A  {turn.answer or '(no answer recorded)'}", tone="dim"))
        return rows or [_ViewRow("  No questions have been recorded yet.")]

    def rows(self) -> list[_ViewRow]:
        if self.tab == 0:
            return self._summary_rows()
        if self.tab == 1:
            rows = self._finding_rows(self.snapshot.findings)
            return rows or [_ViewRow("  No findings match this view.")]
        if self.tab == 2:
            return self._outline_rows()
        return self._history_rows()

    def _selectable_rows(self) -> tuple[list[_ViewRow], list[int]]:
        rows = self.rows()
        return rows, [index for index, row in enumerate(rows) if row.key is not None]

    def move(self, delta: int) -> None:
        _, selectable = self._selectable_rows()
        if not selectable:
            self.cursors[self.tab] = 0
            return
        cursor = self.cursors.get(self.tab, 0)
        self.cursors[self.tab] = min(max(0, cursor + delta), len(selectable) - 1)
        self.status = ""

    def move_to_edge(self, end: bool) -> None:
        _, selectable = self._selectable_rows()
        self.cursors[self.tab] = max(0, len(selectable) - 1) if end else 0
        self.status = ""

    def active_row(self) -> _ViewRow | None:
        rows, selectable = self._selectable_rows()
        if not selectable:
            return None
        cursor = min(self.cursors.get(self.tab, 0), len(selectable) - 1)
        self.cursors[self.tab] = cursor
        return rows[selectable[cursor]]

    def toggle_active(self, *, expand: bool | None = None) -> None:
        row = self.active_row()
        if row is None or row.key is None:
            return
        kind, raw_id = row.key
        if kind == "finding":
            note_id = int(raw_id)
            target = self.expanded_findings
        elif kind == "turn":
            note_id = int(raw_id)
            target = self.expanded_turns
        else:
            if expand is True:
                self.collapsed_nodes.discard(raw_id)
            elif expand is False:
                self.collapsed_nodes.add(raw_id)
            elif raw_id in self.collapsed_nodes:
                self.collapsed_nodes.remove(raw_id)
            else:
                self.collapsed_nodes.add(raw_id)
            return
        if expand is True:
            target.add(note_id)
        elif expand is False:
            target.discard(note_id)
        elif note_id in target:
            target.remove(note_id)
        else:
            target.add(note_id)

    def switch_tab(self, delta: int) -> None:
        self.tab = (self.tab + delta) % len(_TABS)
        self.searching = False
        self.status = ""


class OverviewRenderer:
    _RESET = "\x1b[0m"
    _BOLD = "\x1b[1m"
    _DIM = "\x1b[2m"
    _CYAN = "\x1b[36m"
    _GREEN = "\x1b[32m"
    _YELLOW = "\x1b[33m"

    def __init__(self, model: OverviewModel, *, use_unicode: bool, use_color: bool) -> None:
        self.model = model
        self.use_unicode = use_unicode
        self.use_color = use_color

    def _style(self, value: str, *codes: str) -> str:
        if not self.use_color:
            return value
        return "".join(codes) + value + self._RESET

    def _body_rows(self, width: int) -> tuple[list[_ViewRow], int | None]:
        source = self.model.rows()
        selectable = [index for index, row in enumerate(source) if row.key is not None]
        active_source_index: int | None = None
        if selectable:
            cursor = min(self.model.cursors.get(self.model.tab, 0), len(selectable) - 1)
            self.model.cursors[self.model.tab] = cursor
            active_source_index = selectable[cursor]

        output: list[_ViewRow] = []
        active_output_index: int | None = None
        for source_index, row in enumerate(source):
            prefix = "› " if source_index == active_source_index else "  "
            wrapped = wrap_display(row.text, max(1, width - 2))
            for wrap_index, line in enumerate(wrapped):
                display_prefix = prefix if wrap_index == 0 else "  "
                if source_index == active_source_index and wrap_index == 0:
                    active_output_index = len(output)
                output.append(_ViewRow(display_prefix + line, row.key, row.tone))
        return output, active_output_index

    def render(self, width: int, height: int) -> list[str]:
        width = max(1, min(120, width))
        height = max(1, height)
        if width < 16 or height < 8:
            compact = [
                truncate_display(" DocAtlas / Overview", width),
                truncate_display(" Enlarge the terminal to continue", width),
            ]
            return (compact + [""] * height)[:height]
        snapshot = self.model.snapshot
        stats = (
            f"{len(snapshot.documents)} docs · {len(snapshot.turns)} questions · "
            f"{len(snapshot.findings)} findings"
        )
        if width < 64:
            stats = (
                f"{len(snapshot.documents)}d · {len(snapshot.turns)}q · {len(snapshot.findings)}f"
            )
        divider = ("─" if self.use_unicode else "-") * width
        tabs = "  ".join(
            f"[{name}]" if index == self.model.tab else name for index, name in enumerate(_TABS)
        )
        lines = [
            self._style(join_columns(" DocAtlas / Overview", stats, width), self._CYAN, self._BOLD),
            self._style(divider, self._CYAN, self._DIM),
            self._style(truncate_display(" " + tabs, width), self._BOLD),
            self._style(divider, self._CYAN, self._DIM),
        ]
        body_height = max(1, height - 6)
        body, active_index = self._body_rows(width)
        scroll = self.model.scrolls.get(self.model.tab, 0)
        if active_index is not None:
            if active_index < scroll:
                scroll = active_index
            elif active_index >= scroll + body_height:
                scroll = active_index - body_height + 1
        scroll = min(max(0, scroll), max(0, len(body) - body_height))
        self.model.scrolls[self.model.tab] = scroll
        visible = body[scroll : scroll + body_height]
        for row in visible:
            text = truncate_display(row.text, width)
            if text.startswith("› "):
                text = self._style(text, self._CYAN, self._BOLD)
            elif row.tone == "heading":
                text = self._style(text, self._GREEN, self._BOLD)
            elif row.tone == "label":
                text = self._style(text, self._YELLOW)
            elif row.tone == "dim":
                text = self._style(text, self._DIM)
            lines.append(text)
        lines.extend([""] * (body_height - len(visible)))
        lines.append(self._style(divider, self._CYAN, self._DIM))
        if self.model.searching:
            footer = f" /{self.model.filter_text}"
        elif self.model.status:
            footer = f" {self.model.status}"
        else:
            footer = " Tab views · ↑↓ navigate · Enter expand · / search · e export · Esc close"
        lines.append(self._style(truncate_display(footer, width), self._DIM))
        return lines[:height]


def render_overview_markdown(snapshot: OverviewSnapshot) -> str:
    lines = [
        "# DocAtlas session overview",
        "",
        f"- Session: `{snapshot.session_id or 'unknown'}`",
        f"- Documents: {len(snapshot.documents)}",
        f"- Questions: {len(snapshot.turns)}",
        f"- Analysis notes: {len(snapshot.findings)}",
        f"- Referenced pages: {len(snapshot.referenced_pages)}",
        f"- Search / Read calls: {snapshot.search_count} / {snapshot.read_count}",
        f"- Tree findings: {snapshot.tree_finding_count}",
        "",
        "## Documents",
        "",
    ]
    lines.extend(f"- {document}" for document in snapshot.documents)
    lines.extend(["", "## Findings", ""])
    if not snapshot.findings:
        lines.append("No findings saved yet.")
    for finding in snapshot.findings:
        pages = ", ".join(str(page) for page in finding.pages)
        suffix = f" — pages {pages}" if pages else ""
        lines.extend([f"### Note #{finding.note_id}{suffix}", "", finding.found or "(no summary)"])
        if finding.plan:
            lines.extend(["", f"**Next:** {finding.plan}"])
        for index, evidence in enumerate(finding.evidence, 1):
            lines.extend(
                [
                    "",
                    f"- Evidence {index}: {evidence.source or evidence.filename or evidence.kind}",
                    f"  - {evidence.content}" if evidence.content else "",
                ]
            )
        lines.append("")
    lines.extend(["## Document outline", ""])
    if not snapshot.outline:
        lines.append("No document outline is available.")
    for node in snapshot.outline:
        indent = "  " * node.depth
        page_range = f" ({node.page_range})" if node.page_range else ""
        lines.append(f"{indent}- {node.title}{page_range}")
        if node.summary:
            lines.append(f"{indent}  - Summary: {' '.join(node.summary.splitlines())}")
        for tree_finding in node.findings:
            lines.append(f"{indent}  - Page {tree_finding.page}: {tree_finding.text}")
    lines.extend(["", "## Question history", ""])
    if not snapshot.turns:
        lines.append("No questions have been recorded yet.")
    for turn in snapshot.turns:
        lines.extend(
            [
                f"### Question {turn.number}",
                "",
                turn.question,
                "",
                "**Answer**",
                "",
                turn.answer or "(no answer recorded)",
                "",
            ]
        )
    return "\n".join(line for line in lines if line is not None).rstrip() + "\n"


def export_overview(snapshot: OverviewSnapshot, destination: Path) -> Path:
    """Atomically export an overview with private file permissions."""
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        destination.parent.chmod(0o700)
    except OSError:
        pass
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(render_overview_markdown(snapshot))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        try:
            destination.chmod(0o600)
        except OSError:
            pass
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return destination


class OverviewViewer:
    """Interactive alternate-screen controller for an OverviewModel."""

    def __init__(
        self,
        snapshot: OverviewSnapshot,
        *,
        input_stream: TextIO,
        output_stream: TextIO,
        use_unicode: bool,
        use_color: bool,
        initial_tab: str = "summary",
        export_path: Path | None = None,
    ) -> None:
        tab_names = [name.casefold() for name in _TABS]
        normalized_tab = "outline" if initial_tab.casefold() == "tree" else initial_tab.casefold()
        tab = tab_names.index(normalized_tab) if normalized_tab in tab_names else 0
        self.model = OverviewModel(snapshot=snapshot, tab=tab)
        self.renderer = OverviewRenderer(self.model, use_unicode=use_unicode, use_color=use_color)
        self.input_stream = input_stream
        self.output_stream = output_stream
        self.export_path = export_path
        self._previous_lines: list[str] = []
        self._previous_dimensions: tuple[int, int] | None = None

    def _redraw(self) -> None:
        size = terminal_size(self.output_stream)
        width = max(1, min(120, max(2, size.columns) - 1))
        height = max(1, size.lines)
        dimensions = (size.columns, size.lines)
        if self._previous_dimensions is not None and dimensions != self._previous_dimensions:
            self.output_stream.write("\x1b[2J\x1b[H")
            self._previous_lines = []
        lines = self.renderer.render(width, height)
        row_count = max(len(lines), len(self._previous_lines))
        for index in range(row_count):
            old = self._previous_lines[index] if index < len(self._previous_lines) else None
            new = lines[index] if index < len(lines) else None
            if old == new:
                continue
            self.output_stream.write(f"\x1b[{index + 1};1H\x1b[2K")
            if new is not None:
                self.output_stream.write(new)
        self.output_stream.flush()
        self._previous_lines = lines
        self._previous_dimensions = dimensions

    def _static(self) -> None:
        self.model.status = "Static view · use an interactive terminal for navigation"
        lines = self.renderer.render(91, 24)
        while lines and not lines[-1]:
            lines.pop()
        self.output_stream.write("\n".join(lines) + "\n")
        self.output_stream.flush()

    def _handle_search_key(self, key: str) -> None:
        current = self.model.filter_text
        if key == KEY_ESCAPE:
            self.model.filters[self.model.tab] = ""
            self.model.searching = False
        elif key == KEY_ENTER:
            self.model.searching = False
        elif key == KEY_BACKSPACE:
            self.model.filters[self.model.tab] = current[:-1]
        elif key == KEY_CTRL_U:
            self.model.filters[self.model.tab] = ""
        elif key == KEY_SPACE:
            self.model.filters[self.model.tab] = current + " "
        elif len(key) == 1 and key.isprintable():
            self.model.filters[self.model.tab] = current + key
        self.model.cursors[self.model.tab] = 0
        self.model.scrolls[self.model.tab] = 0

    def _handle_key(self, key: str) -> bool:
        if key == KEY_CTRL_C:
            raise CtrlCInterrupt
        if self.model.searching:
            self._handle_search_key(key)
            return True
        if key in {KEY_ESCAPE, KEY_CTRL_D} or key.casefold() == "q":
            return False
        if key == "\t":
            self.model.switch_tab(1)
        elif key == KEY_SHIFT_TAB:
            self.model.switch_tab(-1)
        elif key.casefold() in {"1", "2", "3", "4"}:
            self.model.tab = int(key) - 1
            self.model.status = ""
        elif key == KEY_UP:
            self.model.move(-1)
        elif key == KEY_DOWN:
            self.model.move(1)
        elif key == KEY_PAGE_UP:
            self.model.move(-max(1, terminal_size(self.output_stream).lines - 6))
        elif key == KEY_PAGE_DOWN:
            self.model.move(max(1, terminal_size(self.output_stream).lines - 6))
        elif key == KEY_CTRL_A:
            self.model.move_to_edge(False)
        elif key == KEY_CTRL_E:
            self.model.move_to_edge(True)
        elif key in {KEY_ENTER, KEY_RIGHT}:
            self.model.toggle_active(expand=True if key == KEY_RIGHT else None)
        elif key == KEY_LEFT:
            self.model.toggle_active(expand=False)
        elif key == "/":
            self.model.searching = True
            self.model.status = ""
        elif key.casefold() == "e":
            if self.export_path is None:
                self.model.status = "Export is unavailable for this session"
            else:
                destination = export_overview(self.model.snapshot, self.export_path)
                self.model.status = f"Exported {destination.name}"
        return True

    def run(self) -> None:
        interactive = (
            os.name == "posix"
            and self.input_stream.isatty()
            and self.output_stream.isatty()
            and os.getenv("TERM", "") != "dumb"
            and os.getenv("DOCATLAS_NO_ALT_SCREEN") != "1"
        )
        if not interactive:
            self._static()
            return

        import termios
        import tty

        descriptor = self.input_stream.fileno()
        previous = termios.tcgetattr(descriptor)
        try:
            tty.setcbreak(descriptor)
            attributes = termios.tcgetattr(descriptor)
            attributes[3] &= ~termios.ISIG
            termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
            self.output_stream.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")
            self.output_stream.flush()
            self._redraw()
            while self._handle_key(read_terminal_key(self.input_stream)):
                self._redraw()
        finally:
            try:
                capture_typeahead(descriptor)
            finally:
                try:
                    termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)
                finally:
                    self.output_stream.write("\x1b[0m\x1b[?25h\x1b[?1049l")
                    self.output_stream.flush()


__all__ = [
    "OverviewModel",
    "OverviewRenderer",
    "OverviewSnapshot",
    "OverviewViewer",
    "build_overview_snapshot",
    "export_overview",
    "render_overview_markdown",
]
