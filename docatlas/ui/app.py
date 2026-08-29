"""Interactive DocAtlas workbench: select documents, preprocess, and chat."""

from __future__ import annotations

import os
import shlex
import subprocess  # nosec B404
import sys
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

try:  # readline is optional on Windows and minimal Python builds.
    import readline
except ImportError:  # pragma: no cover - platform dependent
    readline = None  # type: ignore[assignment]

from ..config import HarnessConfig
from ..remote_pdf import RemotePDFDownloader, is_http_url, safe_display_url
from ..runtime import AgentRuntime, create_agent_runtime
from ..skill_loader import load_skills
from ..workspace import (
    DocumentWorkspace,
    PreprocessStage,
    build_preprocess_stages,
    normalize_document_paths,
)
from .commands import (
    CommandCompletion,
    command_choice_values,
    command_completions,
    command_help_lines,
    command_suggestion,
    is_known_command,
)
from .plain_renderer import PlainRenderer, sanitize_terminal_text
from .terminal import EscapeInterrupt, display_width, terminal_size, terminal_theme, wrap_display

_SKILL_NAMES = ("search", "read", "note", "review")
_DOUBLE_CTRL_C_SECONDS = 2.0


class TUIExit(Exception):
    """Internal control flow for a clean interactive exit."""


def _friendly_path(path: Path) -> str:
    resolved = path.resolve()
    cwd = Path.cwd().resolve()
    home = Path.home().resolve()
    try:
        return str(resolved.relative_to(cwd))
    except ValueError:
        try:
            return str(Path("~") / resolved.relative_to(home))
        except ValueError:
            return str(resolved)


def _human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def _at_path_completions(token: str, *, cwd: Path | None = None) -> list[str]:
    """Return readline candidates for an ``@``-prefixed path token."""
    if not token.startswith("@"):
        return []
    root = (cwd or Path.cwd()).resolve()
    raw = token[1:].strip("'\"")
    expanded = Path(raw).expanduser()
    if not expanded.is_absolute():
        expanded = root / expanded
    parent = expanded if raw.endswith(("/", os.sep)) else expanded.parent
    prefix = "" if raw.endswith(("/", os.sep)) else expanded.name.casefold()
    try:
        candidates = sorted(parent.iterdir(), key=lambda item: item.name.casefold())
    except OSError:
        return []

    matches: list[str] = []
    for candidate in candidates:
        if not candidate.name.casefold().startswith(prefix):
            continue
        if not candidate.is_dir() and candidate.suffix.lower() != ".pdf":
            continue
        try:
            display = candidate.resolve().relative_to(root)
        except ValueError:
            display = candidate.resolve()
        suffix = os.sep if candidate.is_dir() else ""
        matches.append("@" + shlex.quote(str(display)) + suffix)
    return matches


def install_at_completion() -> None:
    """Enable fallback readline completion for commands and ``@`` paths."""
    if readline is None:
        return
    matches: list[str] = []

    def complete(text: str, state: int) -> str | None:
        nonlocal matches
        if state == 0:
            line_buffer = readline.get_line_buffer()
            if line_buffer.startswith("/"):
                begin = readline.get_begidx()
                matches = [
                    candidate.insert_text[begin:] for candidate in command_completions(line_buffer)
                ]
            else:
                matches = _at_path_completions(text)
        return matches[state] if state < len(matches) else None

    try:
        readline.set_completer_delims(" \t\n")
        readline.set_completer(complete)
        readline.parse_and_bind("tab: complete")
    except (AttributeError, RuntimeError):  # pragma: no cover - readline variant
        return


class TUIConsole:
    """Small dependency-free canvas for menus and preprocessing stages."""

    _RESET = "\x1b[0m"
    _BOLD = "\x1b[1m"
    _DIM = "\x1b[2m"
    _CYAN = "\x1b[36m"
    _GREEN = "\x1b[32m"
    _RED = "\x1b[31m"
    _YELLOW = "\x1b[33m"

    def __init__(
        self,
        *,
        stream: TextIO | None = None,
        input_stream: TextIO | None = None,
        input_fn: Callable[[str], str] | None = None,
    ) -> None:
        self.stream = stream or sys.stderr
        self.input_stream = input_stream or sys.stdin
        self.input_fn = input_fn
        self.history: list[str] = []
        self.input_activity: Callable[[], None] | None = None
        self.completion_provider: Callable[[str], list[CommandCompletion]] | None = None
        self.is_tty = bool(getattr(self.stream, "isatty", lambda: False)())
        encoding = getattr(self.stream, "encoding", None) or "utf-8"
        try:
            "╭─✓".encode(encoding)
            unicode_ok = True
        except (LookupError, UnicodeEncodeError):
            unicode_ok = False
        self.use_unicode = self.is_tty and os.getenv("TERM", "") != "dumb" and unicode_ok
        self.use_color = (
            self.is_tty and os.getenv("TERM", "") != "dumb" and "NO_COLOR" not in os.environ
        )
        self.theme = terminal_theme(use_color=self.use_color)
        if self.use_unicode:
            self.top, self.pipe, self.bottom = "╭─", "│", "╰─"
            self.ok, self.fail, self.wait, self.dot = "✓", "✗", "◌", "·"
        else:
            self.top, self.pipe, self.bottom = "+--", "|", "`--"
            self.ok, self.fail, self.wait, self.dot = "OK", "ERROR", "...", "|"

    def _style(self, text: str, *codes: str) -> str:
        if not self.use_color:
            return text
        return "".join(codes) + text + self._RESET

    def write(self, value: str = "") -> None:
        self.stream.write(value + "\n")
        self.stream.flush()

    def _write_wrapped(
        self,
        prefix: str,
        value: str,
        *codes: str,
        continuation_prefix: str | None = None,
    ) -> None:
        width = max(8, min(120, max(2, terminal_size(self.stream).columns) - 1))
        prefix_width = display_width(sanitize_terminal_text(prefix, multiline=True))
        rows = wrap_display(value, max(1, width - prefix_width)) or [""]
        continuation = continuation_prefix or (
            self.pipe + (" " * max(1, prefix_width - display_width(self.pipe)))
        )
        for index, row in enumerate(rows):
            line = (prefix if index == 0 else continuation) + row
            self.write(self._style(line, *codes))

    def panel(self, title: str, lines: list[str], *, color: str | None = None) -> None:
        colour = color or self._CYAN
        safe_title = sanitize_terminal_text(title)
        self.write(f"\n{self._style(self.top, colour)} {self._style(safe_title, self._BOLD)}")
        for line in lines:
            safe_line = (
                sanitize_terminal_text(line, multiline=True).replace("\n", " ").replace("\t", " ")
            )
            self._write_wrapped(f"{self.pipe}  ", safe_line)
        self.write(self._style(self.bottom, colour))

    def prompt(self, label: str, *, use_history: bool = False) -> str:
        label_suffix = f"{label} " if label else ""
        canvas_style = ""
        if not label and self.use_color:
            canvas_style = self.theme.ask_background + self.theme.primary
            prompt = f"{self.theme.success}›{canvas_style} "
        else:
            prompt = f"{self._style('›', self._GREEN)} {label_suffix}"
        if (
            self.input_fn is None
            and os.name == "posix"
            and self.input_stream.isatty()
            and self.is_tty
            and os.getenv("DOCATLAS_SIMPLE_INPUT") != "1"
        ):
            from .path_picker import read_line_with_at_picker

            try:
                return read_line_with_at_picker(
                    prompt,
                    input_stream=self.input_stream,
                    output_stream=self.stream,
                    use_unicode=self.use_unicode,
                    use_color=self.use_color,
                    history=self.history if use_history else None,
                    input_activity=self.input_activity,
                    canvas_style=canvas_style,
                    composer=not label,
                    completion_provider=self.completion_provider if not label else None,
                )
            except EOFError as exc:
                raise TUIExit from exc
        try:
            if self.input_fn is None:
                # Let readline own the prompt in fallback mode so Backspace
                # cannot move into and erase a separately printed prefix.
                return input(f"› {label_suffix}").strip()
            self.stream.write(prompt)
            self.stream.flush()
            return self.input_fn("").strip()
        except EOFError as exc:
            raise TUIExit from exc

    def success(self, label: str, elapsed: float | None = None) -> None:
        suffix = f" {self.dot} {elapsed:.1f}s" if elapsed is not None else ""
        self._write_wrapped(
            f"{self.pipe}  {self._style(self.ok, self._GREEN)} ",
            f"{sanitize_terminal_text(label)}{suffix}",
        )

    def error(self, label: str) -> None:
        self._write_wrapped(
            f"{self.pipe}  {self._style(self.fail, self._RED)} ",
            sanitize_terminal_text(label),
        )

    def run_stage(self, stage: PreprocessStage) -> None:
        title = sanitize_terminal_text(stage.title)
        self.write(f"\n{self._style(self.top, self._CYAN)} {self._style(title, self._BOLD)}")
        started = time.monotonic()
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        # The argv tuple is generated internally and never executed through a shell.
        process = subprocess.Popen(  # nosec B603
            stage.argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        spinner_stop = threading.Event()
        spinner_thread: threading.Thread | None = None
        live_status = self.is_tty and os.getenv("TERM", "") != "dumb"
        if live_status:
            frames = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")

            def animate() -> None:
                index = 0
                while not spinner_stop.is_set():
                    frame = frames[index % len(frames)] if self.use_unicode else self.wait
                    try:
                        self.stream.write(
                            f"\r\x1b[2K{self.pipe}  "
                            f"{self._style(frame, self._YELLOW)} Processing..."
                        )
                        self.stream.flush()
                    except OSError:
                        return
                    index += 1
                    spinner_stop.wait(0.1)

            spinner_thread = threading.Thread(target=animate, daemon=True)
            spinner_thread.start()
        else:
            self.write(f"{self.pipe}  {self._style(self.wait, self._YELLOW)} Processing...")

        spinner_stopped = False

        def stop_spinner() -> None:
            nonlocal spinner_stopped
            if spinner_thread is None or spinner_stopped:
                return
            spinner_stopped = True
            spinner_stop.set()
            spinner_thread.join(timeout=1)
            self.stream.write("\r\x1b[2K")
            self.stream.flush()

        try:
            from .path_picker import terminal_interrupt_monitor

            with terminal_interrupt_monitor(self.input_stream):
                output, _ = process.communicate()
        except KeyboardInterrupt:
            stop_spinner()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            self.error("Interrupted")
            self.write(self._style(self.bottom, self._RED))
            raise
        finally:
            stop_spinner()

        elapsed = time.monotonic() - started
        if process.returncode != 0:
            self.error(f"Failed with exit code {process.returncode}")
            tail = [line.strip() for line in output.splitlines() if line.strip()][-8:]
            for line in tail:
                self.write(f"{self.pipe}    {sanitize_terminal_text(line)[:180]}")
            self.write(self._style(self.bottom, self._RED))
            raise RuntimeError(f"preprocessing failed: {stage.title}")
        self.success("Completed", elapsed)
        self.write(self._style(self.bottom, self._GREEN))


@dataclass
class TUIOptions:
    paths: list[str] = field(default_factory=list)
    recursive: bool = False
    force: bool = False
    assume_yes: bool = False
    workspace_root: str | None = None
    model: str | None = None
    max_turns: int | None = None
    max_documents: int = 100
    show_reasoning: bool = False
    memory: bool = True
    tree_annotate: bool = True


class DocAtlasTUI:
    """Interactive document selection and multi-turn chat application."""

    def __init__(self, options: TUIOptions, *, console: TUIConsole | None = None) -> None:
        self.options = options
        self.console = console or TUIConsole()
        self._last_ctrl_c_at: float | None = None
        self._remote_sources: dict[Path, str] = {}
        self.console.input_activity = self._reset_ctrl_c
        self.console.completion_provider = command_completions

    def _reset_ctrl_c(self) -> None:
        self._last_ctrl_c_at = None

    def _ctrl_c_requests_exit(self, cancelled: str) -> bool:
        now = time.monotonic()
        if (
            self._last_ctrl_c_at is not None
            and now - self._last_ctrl_c_at <= _DOUBLE_CTRL_C_SECONDS
        ):
            self._last_ctrl_c_at = None
            self.console.write(self.console._style("Exiting DocAtlas", self.console._DIM))
            return True
        self._last_ctrl_c_at = now
        self.console.write(
            self.console._style(
                f"{cancelled} · press Ctrl+C again within 2s to exit",
                self.console._DIM,
            )
        )
        return False

    def _select_documents_safely(self, seed_paths: list[str] | None = None) -> list[Path]:
        pending = seed_paths
        while True:
            try:
                documents = self._select_documents(pending)
                self._reset_ctrl_c()
                return documents
            except EscapeInterrupt:
                self._reset_ctrl_c()
                self.console.write(self.console._style("Selection cancelled", self.console._DIM))
                pending = None
            except KeyboardInterrupt:
                if self._ctrl_c_requests_exit("Selection cancelled"):
                    raise TUIExit
                pending = None

    def _confirm(
        self,
        prompt: str,
        *,
        default: bool = True,
        accept_assume_yes: bool = False,
    ) -> bool:
        if accept_assume_yes and self.options.assume_yes:
            return True
        hint = "[Y/n]" if default else "[y/N]"
        answer = self.console.prompt(f"{prompt} {hint}").casefold()
        if not answer:
            return default
        return answer in {"y", "yes"}

    def _show_documents(self, documents: list[Path], *, title: str = "Documents") -> None:
        lines: list[str] = []
        for index, path in enumerate(documents, 1):
            remote_source = self._remote_sources.get(path.resolve())
            remote_arrow = "←" if self.console.use_unicode else "<-"
            display = (
                f"{path.name} {remote_arrow} {remote_source}"
                if remote_source
                else _friendly_path(path)
            )
            lines.append(f"{index:>2}. {display}  ({_human_size(path.stat().st_size)})")
        self.console.panel(title, lines)

    def _remote_cache_root(self) -> Path:
        base = (
            Path(self.options.workspace_root).expanduser().resolve()
            if self.options.workspace_root is not None
            else (Path.cwd() / "outputs" / "tui").resolve()
        )
        return base / "_downloads"

    def _resolve_document_inputs(
        self,
        inputs: Iterable[str | Path],
        *,
        recursive: bool,
    ) -> list[Path]:
        resolved_inputs: list[str | Path] = []
        downloader: RemotePDFDownloader | None = None
        remote_count = 0
        for raw in inputs:
            raw_text = str(raw).strip()
            candidate_url = (
                raw_text[1:] if raw_text.startswith("@") and is_http_url(raw_text[1:]) else raw_text
            )
            if not is_http_url(candidate_url):
                if "://" in candidate_url:
                    raise ValueError("remote PDFs must use an HTTP or HTTPS URL")
                resolved_inputs.append(raw)
                continue
            remote_count += 1
            if remote_count > self.options.max_documents:
                raise ValueError(f"selected more than {self.options.max_documents} remote PDFs")
            if downloader is None:
                downloader = RemotePDFDownloader(self._remote_cache_root())
            display_url = safe_display_url(candidate_url)
            self.console.write(
                f"  {self.console._style(self.console.wait, self.console._YELLOW)} "
                f"Fetching {display_url}"
            )
            from .path_picker import terminal_interrupt_monitor

            with terminal_interrupt_monitor(self.console.input_stream):
                downloaded = downloader.download(candidate_url)
            self._remote_sources[downloaded.path.resolve()] = downloaded.display_url
            status = "Cached" if downloaded.from_cache else "Downloaded"
            self.console.write(
                f"  {self.console._style(self.console.ok, self.console._GREEN)} "
                f"{status} {downloaded.path.name} ({_human_size(downloaded.size)})"
            )
            resolved_inputs.append(downloaded.path)
        return normalize_document_paths(
            resolved_inputs,
            recursive=recursive,
            max_documents=self.options.max_documents,
        )

    def _paths_from_line(self, value: str) -> list[str]:
        try:
            tokens = shlex.split(value, posix=os.name != "nt")
        except ValueError as exc:
            self.console.error(f"Could not parse document input: {exc}")
            return []
        sources: list[str] = []
        for token in tokens:
            # A bare at-sign is the path-picker trigger, not a credential.
            if token == "@":  # nosec B105
                continue
            if token.startswith("@") and len(token) > 1:
                sources.append(token[1:])
            elif is_http_url(token):
                sources.append(token)
        if sources:
            return sources
        stripped = value.strip().strip("'\"")
        return [stripped] if stripped else []

    def _select_documents(self, seed_paths: list[str] | None = None) -> list[Path]:
        pending = list(seed_paths or [])
        while True:
            recursive = self.options.recursive
            if not pending:
                self.console.panel(
                    "Open documents",
                    [
                        "Press @ to open the navigable PDF and folder picker.",
                        "You can also paste a local path or an HTTP(S) PDF URL.",
                        "[1] One PDF   [2] Multiple PDFs   [3] Entire folder   [q] Quit",
                    ],
                )
                choice = self.console.prompt("Select").strip()
                if choice.casefold() in {"q", "quit", "/quit", "/exit"}:
                    raise TUIExit
                if choice == "1":
                    pending = self._paths_from_line(
                        self.console.prompt("PDF path, URL, or press @")
                    )
                elif choice == "2":
                    self.console.write(
                        "Add one PDF path or URL per line; submit an empty line when done."
                    )
                    while True:
                        line = self.console.prompt(f"PDF {len(pending) + 1}")
                        if not line:
                            break
                        pending.extend(self._paths_from_line(line))
                elif choice == "3":
                    pending = self._paths_from_line(self.console.prompt("Folder path or press @"))
                    recursive = self._confirm("Include subfolders?", default=False)
                else:
                    pending = self._paths_from_line(choice)

            try:
                documents = self._resolve_document_inputs(pending, recursive=recursive)
            except (FileNotFoundError, ValueError) as exc:
                self.console.panel("Could not open documents", [str(exc)], color=self.console._RED)
                pending = []
                continue
            self._show_documents(documents, title="Selected documents")
            if self._confirm("Use these documents?", accept_assume_yes=True):
                return documents
            pending = []

    def _prepare_workspace(
        self,
        documents: list[Path],
        config: HarnessConfig,
        *,
        force: bool,
    ) -> DocumentWorkspace:
        workspace = DocumentWorkspace.create(
            documents,
            workspace_root=self.options.workspace_root,
        )
        workspace.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            workspace.root.chmod(0o700)
        except OSError as exc:
            self.console.error(f"Could not tighten workspace permissions: {exc}")
        if not force and workspace.is_ready(model=config.azure_deployment):
            self.console.panel(
                "Workspace cache",
                [
                    f"key        {workspace.key}",
                    f"documents  {len(documents)}",
                    "status     ready; preprocessing skipped",
                ],
                color=self.console._GREEN,
            )
            return workspace
        stages = build_preprocess_stages(
            workspace,
            model=config.azure_deployment,
            force=force,
            force_trees=(
                not force
                and workspace.tree_json.exists()
                and workspace.cached_model() != config.azure_deployment
            ),
        )
        self.console.panel(
            "Prepare workspace",
            [
                f"documents  {len(documents)}",
                f"cache      {_friendly_path(workspace.root)}",
                f"stages     {len(stages)}",
            ],
        )
        for stage in stages:
            self.console.run_stage(stage)
        if not workspace.tree_json.is_file():
            raise RuntimeError(f"PageIndex tree was not created: {workspace.tree_json}")
        missing_markdown = [
            document.name
            for document in documents
            if not (workspace.markdown_dir / document.stem).is_dir()
        ]
        if missing_markdown:
            raise RuntimeError(f"Markdown was not created for: {', '.join(missing_markdown)}")
        workspace.save_metadata(model=config.azure_deployment)
        return workspace

    def _create_runtime(
        self,
        workspace: DocumentWorkspace,
        config: HarnessConfig,
    ) -> tuple[AgentRuntime, PlainRenderer]:
        skills_root = Path(__file__).resolve().parent.parent / "skills"
        skills = load_skills([skills_root / name for name in _SKILL_NAMES])
        runtime = create_agent_runtime(
            doc_env=workspace.doc_env(),
            question="",
            skills=skills,
            config=config,
            sessions_root=workspace.root / "sessions",
        )
        renderer = PlainRenderer(
            runtime.session,
            skills=[skill.name for skill in skills],
            show_reasoning=self.options.show_reasoning,
        )
        runtime.loop.callbacks = renderer.as_callbacks()
        renderer.print_session()
        return runtime, renderer

    def _record_message(self, runtime: AgentRuntime, role: str, text: str) -> None:
        try:
            runtime.session.refresh_from_disk()
            conversation = runtime.session.workspace.setdefault("conversation", [])
            if not isinstance(conversation, list):
                conversation = []
                runtime.session.workspace["conversation"] = conversation
            conversation.append({"role": role, "text": text})
            runtime.session.save()
        except (OSError, ValueError):
            return

    def _show_overview(
        self,
        runtime: AgentRuntime,
        workspace: DocumentWorkspace,
        mode: str,
    ) -> None:
        from .overview import OverviewViewer, build_overview_snapshot, export_overview

        normalized = mode.casefold() or "summary"
        normalized = {
            "notes": "findings",
            "tree": "outline",
            "questions": "history",
        }.get(normalized, normalized)
        if normalized not in command_choice_values("/overview"):
            self.console.error("Usage: /overview [summary|findings|outline|history|export]")
            return
        try:
            runtime.session.refresh_from_disk()
        except (OSError, ValueError):
            # The in-memory session is still a useful, read-only fallback.
            pass
        snapshot = build_overview_snapshot(runtime.session, list(workspace.documents))
        export_path = workspace.root / "overview.md"
        if normalized == "export":
            destination = export_overview(snapshot, export_path)
            self.console.success(f"Overview exported to {_friendly_path(destination)}")
            return
        OverviewViewer(
            snapshot,
            input_stream=self.console.input_stream,
            output_stream=self.console.stream,
            use_unicode=self.console.use_unicode,
            use_color=self.console.use_color,
            initial_tab=normalized,
            export_path=export_path,
        ).run()

    def _help(self) -> None:
        self.console.panel(
            "Commands",
            [
                "@                   open the navigable file/folder picker",
                *command_help_lines(),
                "Esc                 cancel input or interrupt the active turn",
                "Ctrl+C twice        cancel, then exit DocAtlas within 2 seconds",
                "Up / Down           browse previous questions",
                "Tab                 complete a /command or selected option",
            ],
        )

    def _command_hint(self) -> None:
        self.console._write_wrapped(
            "  ",
            "Type / for commands · @ for documents · Ctrl+C twice to exit",
            self.console._DIM,
            continuation_prefix="  ",
        )

    def _chat(
        self,
        workspace: DocumentWorkspace,
        config: HarnessConfig,
    ) -> tuple[str, list[Path] | None, bool]:
        runtime, renderer = self._create_runtime(workspace, config)
        question_number = 1
        self._command_hint()
        while True:
            try:
                value = self.console.prompt("", use_history=True)
            except EscapeInterrupt:
                self._reset_ctrl_c()
                self.console.write(self.console._style("Input cancelled", self.console._DIM))
                continue
            except KeyboardInterrupt:
                if self._ctrl_c_requests_exit("Input cancelled"):
                    return "quit", None, False
                continue
            self._reset_ctrl_c()
            if not value:
                continue
            command, _, remainder = value.partition(" ")
            command = command.casefold()
            remainder = remainder.strip()
            if command.startswith("/") and not is_known_command(command):
                suggestion = command_suggestion(command)
                suffix = f"; did you mean {suggestion}?" if suggestion else ""
                self.console.error(f"Unknown command {command}{suffix}")
                continue
            if command in {"/quit", "/exit"}:
                return "quit", None, False
            if command == "/help":
                self._help()
                continue
            if command == "/files":
                self._show_documents(list(workspace.documents), title="Active documents")
                continue
            if command == "/overview":
                try:
                    self._show_overview(runtime, workspace, remainder)
                except EscapeInterrupt:
                    self._reset_ctrl_c()
                except KeyboardInterrupt:
                    if self._ctrl_c_requests_exit("Overview closed"):
                        return "quit", None, False
                continue
            if command == "/clear":
                runtime, renderer = self._create_runtime(workspace, config)
                question_number = 1
                self.console.success("Conversation cleared")
                continue
            if command == "/rebuild":
                return "replace", list(workspace.documents), True
            if command in {"/new", "/add"} or value.startswith("@"):
                raw_paths = self._paths_from_line(remainder if command.startswith("/") else value)
                if command == "/new" and not raw_paths:
                    return "select", None, False
                if not raw_paths:
                    self.console.error("Add at least one @path or PDF URL")
                    continue
                base = [] if command == "/new" else list(workspace.documents)
                try:
                    documents = self._resolve_document_inputs(
                        [*base, *raw_paths],
                        recursive=self.options.recursive,
                    )
                except (FileNotFoundError, ValueError) as exc:
                    self.console.error(str(exc))
                    continue
                return "replace", documents, False

            runtime.session.notes.question = value
            runtime.session.save()
            self._record_message(runtime, "user", value)
            user_message = value
            if question_number == 1 and len(workspace.documents) > 1:
                doc_ids = ", ".join(document.stem for document in workspace.documents)
                user_message = (
                    f"Available document IDs: {doc_ids}. Pass doc_id to Search and Read when "
                    f"selecting a document.\n\n{value}"
                )
            try:
                from .path_picker import terminal_interrupt_monitor

                with terminal_interrupt_monitor(self.console.input_stream):
                    result = runtime.loop.run(user_message, continue_conversation=True)
            except EscapeInterrupt:
                renderer.abort("Request interrupted")
                self._reset_ctrl_c()
                continue
            except KeyboardInterrupt:
                renderer.abort("Request interrupted")
                if self._ctrl_c_requests_exit("Request interrupted"):
                    return "quit", None, False
                continue
            if not renderer.print_answer(result.answer):
                sys.stdout.write(result.answer.rstrip() + "\n")
                sys.stdout.flush()
            renderer.print_stats(result)
            self._record_message(runtime, "assistant", result.answer)
            question_number += 1

    def run(self) -> int:
        if not self.console.input_stream.isatty() or not self.console.is_tty:
            raise RuntimeError("the interactive TUI requires a terminal; use `docatlas chat` in CI")
        install_at_completion()
        self.console.panel(
            "DocAtlas",
            [
                "Select PDFs, let DocAtlas prepare them, then ask follow-up questions.",
                "Press @ for the path picker, or choose one of the document modes.",
            ],
            color=self.console._GREEN,
        )
        config = HarnessConfig.from_env()
        if self.options.model:
            config.azure_deployment = self.options.model
            config.aux_model = self.options.model
        if self.options.max_turns is not None:
            if self.options.max_turns < 1:
                raise ValueError("--max-turns must be at least 1")
            config.max_turns = self.options.max_turns
        config.enable_memory = self.options.memory
        config.enable_tree_annotate = self.options.tree_annotate

        documents = self._select_documents_safely(self.options.paths)
        force = self.options.force
        while True:
            try:
                workspace = self._prepare_workspace(documents, config, force=force)
            except EscapeInterrupt:
                self._reset_ctrl_c()
                self.console.panel(
                    "Preparation cancelled",
                    [
                        "The active child process was stopped and reaped.",
                        "Completed cache artifacts remain available; choose documents to continue.",
                    ],
                    color=self.console._YELLOW,
                )
                documents = self._select_documents_safely()
                force = False
                continue
            except KeyboardInterrupt:
                if self._ctrl_c_requests_exit("Preparation cancelled"):
                    raise TUIExit
                self.console.panel(
                    "Preparation cancelled",
                    [
                        "The active child process was stopped and reaped.",
                        "Completed cache artifacts remain available; choose documents to continue.",
                    ],
                    color=self.console._YELLOW,
                )
                documents = self._select_documents_safely()
                force = False
                continue
            action, replacement, force = self._chat(workspace, config)
            if action == "quit":
                self.console.panel(
                    "Goodbye",
                    ["Your cached workspace remains under outputs/tui."],
                    color=self.console._GREEN,
                )
                return 0
            if action == "select":
                documents = self._select_documents_safely()
            elif replacement is not None:
                documents = replacement


def run_tui(options: TUIOptions) -> int:
    """Public entry point used by the CLI and one-click launcher."""
    try:
        return DocAtlasTUI(options).run()
    except TUIExit:
        return 0


__all__ = ["DocAtlasTUI", "TUIConsole", "TUIOptions", "install_at_completion", "run_tui"]
