from __future__ import annotations

import fcntl
import io
import os
import pty
import select
import struct
import termios
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from docatlas.session.doc_env import DocEnv
from docatlas.session.store import SessionStore
from docatlas.skills._common.note_store import NoteStore
from docatlas.ui.overview import (
    OverviewModel,
    OverviewRenderer,
    OverviewViewer,
    build_overview_snapshot,
    export_overview,
    render_overview_markdown,
)
from docatlas.ui.terminal import KEY_ENTER, KEY_SHIFT_TAB, CtrlCInterrupt, display_width


def _session() -> SimpleNamespace:
    notes = NoteStore(question="Which segment changed most?")
    notes.add_analysis(
        found="Cloud revenue grew on Page 7.",
        plan="Compare Pages 8-9 next.",
        evidence=[
            {
                "type": "text",
                "source": "Page 7, Revenue",
                "content": "Cloud revenue increased by 21%.",
            }
        ],
    )
    notes.add_analysis(
        found="No regional breakdown was found.",
        evidence=[{"type": "text", "source": "Page 12", "content": "No breakdown."}],
    )
    tree = [
        {
            "node_id": "0001",
            "title": "Financial results",
            "summary": "Annual performance summary.",
            "start_index": 1,
            "end_index": 12,
            "nodes": [
                {
                    "node_id": "0002",
                    "title": "Revenue",
                    "start_index": 7,
                    "end_index": 9,
                    "page_findings": [{"page_id": 7, "observation_summary": "Cloud grew 21%."}],
                }
            ],
        }
    ]
    workspace = {
        "conversation": [
            {"role": "user", "text": "What changed?"},
            {"role": "assistant", "text": "Revenue changed."},
            {"role": "user", "text": "Which segment?"},
            {"role": "assistant", "text": "Cloud."},
        ],
        "search_history": [{"query": "revenue"}],
        "read_history": [{"pages": [7]}],
    }
    return SimpleNamespace(
        session_id="session-test",
        created_at="2026-08-29T00:00:00+00:00",
        notes=notes,
        tree=tree,
        workspace=workspace,
    )


def test_snapshot_aggregates_session_without_mutating_it(tmp_path: Path) -> None:
    session = _session()
    before_notes = session.notes.to_dict()
    before_tree = repr(session.tree)

    snapshot = build_overview_snapshot(session, [tmp_path / "report.pdf"])

    assert snapshot.documents == ("report.pdf",)
    assert snapshot.current_question == "Which segment changed most?"
    assert [turn.question for turn in snapshot.turns] == ["What changed?", "Which segment?"]
    assert [turn.answer for turn in snapshot.turns] == ["Revenue changed.", "Cloud."]
    assert len(snapshot.findings) == 2
    # Planned pages are not counted as referenced evidence until they are read.
    assert snapshot.referenced_pages == (7, 12)
    assert snapshot.search_count == 1
    assert snapshot.read_count == 1
    assert snapshot.tree_finding_count == 1
    assert session.notes.to_dict() == before_notes
    assert repr(session.tree) == before_tree


def test_snapshot_defensively_sanitizes_untrusted_session_text(tmp_path: Path) -> None:
    session = _session()
    session.workspace["conversation"][0]["text"] = "unsafe\x1b[31m question"
    session.tree[0]["title"] = "Finance\x00\x1b[2J"
    session.notes.analysis_entries()[0].data["note_id"] = "not-an-int"
    session.notes.analysis_entries()[0].data["evidence"] = {"bad": "shape"}

    snapshot = build_overview_snapshot(session, [tmp_path / "report.pdf"])

    rendered = repr(snapshot)
    assert "\x1b" not in rendered
    assert "\x00" not in rendered
    assert snapshot.findings[0].note_id == 1
    assert snapshot.findings[0].evidence == ()


def test_renderer_fits_narrow_terminal_and_supports_view_navigation(tmp_path: Path) -> None:
    snapshot = build_overview_snapshot(_session(), [tmp_path / "中文报告.pdf"])
    model = OverviewModel(snapshot)
    renderer = OverviewRenderer(model, use_unicode=True, use_color=False)

    summary = renderer.render(40, 12)
    model.switch_tab(1)
    model.toggle_active()
    findings = renderer.render(40, 12)
    model.switch_tab(1)
    outline = renderer.render(40, 12)
    model.toggle_active()
    expanded_outline = renderer.render(40, 12)
    tiny = renderer.render(10, 4)

    assert len(summary) == len(findings) == len(outline) == 12
    assert all(display_width(line) <= 40 for line in [*summary, *findings, *outline])
    assert any("Summary" in line for line in summary)
    assert any("Evidence" in line for line in findings)
    assert any("Financial results" in line for line in outline)
    assert any("Annual performance" in line for line in expanded_outline)
    assert len(tiny) == 4
    assert all(display_width(line) <= 10 for line in tiny)


def test_model_filters_findings_and_expands_history(tmp_path: Path) -> None:
    snapshot = build_overview_snapshot(_session(), [tmp_path / "report.pdf"])
    model = OverviewModel(snapshot, tab=1)
    model.filters[1] = "regional"

    finding_rows = model.rows()
    assert any("regional" in row.text for row in finding_rows)
    assert not any("Cloud revenue" in row.text for row in finding_rows)

    model.tab = 3
    model.toggle_active()
    history_rows = model.rows()
    assert any("A  Cloud." in row.text for row in history_rows)


def test_markdown_export_is_complete_and_private(tmp_path: Path) -> None:
    snapshot = build_overview_snapshot(_session(), [tmp_path / "report.pdf"])
    destination = export_overview(snapshot, tmp_path / "private" / "overview.md")
    content = destination.read_text(encoding="utf-8")

    assert content == render_overview_markdown(snapshot)
    assert "# DocAtlas session overview" in content
    assert "Cloud revenue increased by 21%." in content
    assert "## Document outline" in content
    assert "Annual performance summary." in content
    assert "## Question history" in content
    assert destination.stat().st_mode & 0o777 == 0o600
    assert destination.parent.stat().st_mode & 0o077 == 0


def test_noninteractive_viewer_prints_static_overview(tmp_path: Path) -> None:
    snapshot = build_overview_snapshot(_session(), [tmp_path / "report.pdf"])
    output = io.StringIO()
    viewer = OverviewViewer(
        snapshot,
        input_stream=io.StringIO(),
        output_stream=output,
        use_unicode=False,
        use_color=False,
    )

    viewer.run()

    assert "DocAtlas / Overview" in output.getvalue()
    assert "Financial results" not in output.getvalue()  # Summary is the default view.


def test_viewer_keyboard_search_tab_cycle_and_export(tmp_path: Path) -> None:
    snapshot = build_overview_snapshot(_session(), [tmp_path / "report.pdf"])
    destination = tmp_path / "overview.md"
    viewer = OverviewViewer(
        snapshot,
        input_stream=io.StringIO(),
        output_stream=io.StringIO(),
        use_unicode=True,
        use_color=False,
        export_path=destination,
    )

    viewer._handle_key("2")
    viewer._handle_key("/")
    for char in "cloud":
        viewer._handle_key(char)
    viewer._handle_key(KEY_ENTER)
    assert viewer.model.tab_name == "Findings"
    assert viewer.model.filter_text == "cloud"
    assert any("Cloud revenue" in row.text for row in viewer.model.rows())

    viewer._handle_key(KEY_SHIFT_TAB)
    assert viewer.model.tab_name == "Summary"
    viewer._handle_key("e")
    assert destination.is_file()
    assert viewer.model.status == "Exported overview.md"


def test_opening_overview_does_not_write_session_file(tmp_path: Path) -> None:
    document = tmp_path / "report.pdf"
    session = SessionStore.new(
        DocEnv.from_cli(pdf=str(document)), sessions_root=tmp_path / "sessions"
    )
    before = session.path.read_bytes()
    snapshot = build_overview_snapshot(session, [document])

    OverviewViewer(
        snapshot,
        input_stream=io.StringIO(),
        output_stream=io.StringIO(),
        use_unicode=False,
        use_color=False,
    ).run()

    assert session.path.read_bytes() == before


def _read_available(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    while True:
        ready, _, _ = select.select([descriptor], [], [], 0.05)
        if not ready:
            return b"".join(chunks)
        try:
            chunk = os.read(descriptor, 65_536)
        except OSError:
            return b"".join(chunks)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


@pytest.mark.parametrize(
    ("payload", "expected_error"),
    [(b"\t\x1b[B\r\x1b", None), (b"\x03", CtrlCInterrupt)],
)
def test_interactive_viewer_uses_alt_screen_and_restores_terminal(
    tmp_path: Path, monkeypatch, payload: bytes, expected_error: type[BaseException] | None
) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    snapshot = build_overview_snapshot(_session(), [tmp_path / "report.pdf"])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 72, 0, 0))
    input_stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output_stream = os.fdopen(os.dup(input_stream.fileno()), "w", encoding="utf-8", closefd=True)
    before = termios.tcgetattr(input_stream.fileno())
    errors: list[BaseException] = []

    def target() -> None:
        try:
            OverviewViewer(
                snapshot,
                input_stream=input_stream,
                output_stream=output_stream,
                use_unicode=True,
                use_color=False,
            ).run()
        except BaseException as exc:  # noqa: BLE001 - captured for PTY assertions
            errors.append(exc)

    thread = threading.Thread(target=target)
    thread.start()
    time.sleep(0.05)
    os.write(master, payload)
    thread.join(timeout=2)
    after = termios.tcgetattr(input_stream.fileno())
    output = _read_available(master).decode("utf-8", errors="replace")
    output_stream.close()
    input_stream.close()
    os.close(master)

    assert not thread.is_alive()
    if expected_error is None:
        assert errors == []
    else:
        assert len(errors) == 1
        assert isinstance(errors[0], expected_error)
    assert after == before
    assert "\x1b[?1049h" in output
    assert "\x1b[?1049l" in output
    assert "Findings" in output
