# DocAtlas: Long-Document Understanding as Mutable-State Interaction

<p align="center">
  <a href="https://github.com/microsoft/DocAtlas-Harness/actions/workflows/ci.yml"><img src="https://github.com/microsoft/DocAtlas-Harness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/python-3.10–3.13-blue.svg" alt="Python 3.10 through 3.13">
  <a href="https://agentskills.io/"><img src="https://img.shields.io/badge/Agent%20Skills-valid-6f42c1.svg" alt="Agent Skills compatible"></a>
</p>

DocAtlas is an agent harness for evidence-grounded reasoning over long,
multimodal PDF documents. Instead of treating retrieval as a one-shot lookup,
it gives the model a mutable workspace: search the document tree, read selected
pages and figures, save page-grounded notes, and recall them when synthesizing
an answer.

<p align="center">
  <img src="https://raw.githubusercontent.com/microsoft/DocAtlas-Harness/main/assets/framework.png" alt="DocAtlas framework" width="100%">
</p>

## Why DocAtlas

- **Mutable retrieval state** — page-grounded findings enrich the session-local
  document tree and improve later search.
- **Selective multimodal access** — text, page images, and extracted figures are
  requested independently, keeping context focused.
- **Explicit working memory** — structured notes preserve evidence across long
  investigations without retaining every page in context.
- **Inspectable execution** — every action is a JSON-over-stdio Skill call with
  a persisted session and structured trace.
- **Portable Skills** — `search`, `read`, `note`, and `review` conform to the
  Agent Skills naming and metadata specification.

## Reported results

| Backbone | Setting | MMLongBench-Doc | FinRAGBench-V | LongDocURL |
|---|---|:---:|:---:|:---:|
| GPT-5.4 | direct input | 62.4 | 55.1 | 66.9 |
| **GPT-5.4** | **+ DocAtlas** | **71.4** | **75.6** | **78.8** |
| GPT-5.2 | + DocAtlas | 70.6 | 75.2 | 77.5 |
| Qwen3.5-4B | direct input | 54.4 | 52.8 | 52.4 |
| Qwen3.5-4B | + DocAtlas | 61.0 | 67.9 | 72.5 |
| Qwen3.5-4B | + DocAtlas + RL | 63.7 | 71.7 | — |
| Qwen3.5-9B | + DocAtlas + RL | 64.4 | 72.6 | — |
| Human expert | reference | 65.8 | — | — |

MMLongBench-Doc reports overall accuracy; FinRAGBench-V and LongDocURL use
LLM-as-judge evaluation. See the paper citation below for the full protocol,
ablations, and model settings.

## Quick start: run a Skill locally

DocAtlas uses [uv](https://github.com/astral-sh/uv) and the checked-in lockfile.
The dependency versions in `uv.lock` are the tested release environment.

```bash
git clone https://github.com/microsoft/DocAtlas-Harness.git
cd DocAtlas-Harness
uv sync --locked

uv run --locked python docatlas/skills/read/scripts/run.py \
  --pdf data/sample_pdfs/sample_report.pdf \
  --pages 1,3
```

The first environment sync can occupy roughly 5 GB on Linux because Docling's
standard pipeline brings Torch and platform acceleration libraries. The first
`build-md` run also downloads approximately 2 GB of document-layout models to
the Hugging Face cache.

## Interactive TUI

Copy the environment template and configure an Azure OpenAI deployment:

```bash
cp .env.example .env
az login                              # omit when using AZURE_OPENAI_API_KEY
uv run --locked docatlas --help
```

`harness` remains available as a compatibility alias, but new integrations
should use the canonical `docatlas` command.

Start the workbench with one command:

```bash
bash scripts/start_tui.sh
# equivalent: uv run --locked docatlas
```

The opening screen accepts one PDF, multiple PDFs, a directory, or an HTTP(S)
PDF URL. Typing `@` immediately opens a navigable local-file picker: use
`↑`/`↓`, Enter to open/select,
Backspace or `←` for the parent directory, Space for multi-select, `d` to
finish a multi-selection, and `f` to select the current folder. On terminals
without raw-input support, `@` + Tab remains available as a fallback.

You can also launch with documents already selected:

```bash
# One document
bash scripts/start_tui.sh @report.pdf

# Multiple documents (quote paths containing spaces)
bash scripts/start_tui.sh @report.pdf @"annual report.pdf"

# Every PDF in a folder; add --recursive to include subfolders
bash scripts/start_tui.sh @reports/ --recursive

# A remote PDF (quote signed URLs so the shell does not expand metacharacters)
bash scripts/start_tui.sh 'https://example.com/reports/annual.pdf?token=...'
```

Selections are capped at 100 PDFs by default; use `--max-documents N` to
increase the limit explicitly for a larger corpus.

DocAtlas builds or reuses a content-aware workspace under `outputs/tui/`, then
stays open for follow-up questions. Available commands are:

| Command | Action |
|---|---|
| `@` | Open the navigable PDF/folder picker. |
| `/add <@path\|URL>` | Add local or remote PDFs and begin a new document conversation. |
| `/new <@path\|URL>` | Replace the active document set. |
| `/files` | Show active documents. |
| `/overview [view]` | Open the local session overview (`summary`, `findings`, `outline`, or `history`). |
| `/overview export` | Write a private `overview.md` inside the active workspace. |
| `/clear` | Clear conversation history but keep documents and cached preprocessing. |
| `/rebuild` | Force Markdown and PageIndex regeneration. |
| `/quit` | Exit; cached work remains available. |

`/overview` is a read-only TUI view and never calls the model or enters the
agent loop. Use Tab to switch views, `↑`/`↓` to navigate, Enter to expand,
`/` to filter, `e` to export, and Esc to return to chat.

Press Esc or Ctrl+C once to cancel the current input or interrupt an active
model, Skill, or preprocessing turn. Press Ctrl+C again within two seconds to
exit DocAtlas cleanly. The prompt uses a protected single-line editor: long
questions scroll horizontally, and Backspace, Delete, `←`/`→`, Home/End,
Ctrl+U, and Ctrl+W cannot erase the `›` prompt. Use `↑`/`↓` to browse
question history.

## Command-line workflows

Run the complete non-interactive sample pipeline:

```bash
bash scripts/demo_end_to_end.sh
```

Interactive terminals get a dependency-free, Codex-style execution view:

<p align="center">
  <img src="assets/tui-preview.svg" alt="DocAtlas terminal interface showing Search and Read tool calls" width="92%">
</p>

```text
╭─ DocAtlas
│  session   7a71c003...
│  document  sample_report
│  skills    search read note review
│  state     outputs/sessions/7a71c003.../session.json
╰─ Ready

╭─ Turn 1
│  ◌ Waiting for model...
├─ Search
│  query  Find the financial highlights and roadmap
│  ◌ Running...
│  ✓ Completed · 6.9s
╰─ Turn 1 complete · 12.4s
```

Reasoning summaries are hidden by default. Use `--show-reasoning` to display
API-provided summaries, `--verbose` for SDK logs, or `--quiet` for only the
answer. Colour is disabled automatically outside a TTY and when `NO_COLOR` is
set.

For an already preprocessed document:

```bash
uv run --locked docatlas chat \
  --skill search --skill read --skill note --skill review \
  --pdf document.pdf \
  --markdown-dir markdown/ \
  --tree-json trees/document_structure.json \
  --message "What are the report's main conclusions, and which pages support them?"
```

The final answer is written to stdout. Progress, tool calls, token usage, and
the session path are written to stderr, so the command remains pipe-friendly.
For structured integrations, use JSON mode:

```bash
uv run --locked docatlas chat \
  --pdf document.pdf --markdown-dir markdown/ \
  --tree-json trees/document_structure.json \
  --message "Summarize the principal risks with page citations." \
  --format json | jq -r .answer
```

## The four Skills

| Skill | Role |
|---|---|
| `search` | Uses an auxiliary model to select relevant nodes from a PageIndex tree. |
| `read` | Returns page text, optional page screenshots, and selected figure pixels. |
| `note` | Stores findings, plans, and page-anchored evidence. |
| `review` | Retrieves the saved notes relevant to a focused query. |

Validate all four against the Agent Skills specification:

```bash
for skill in search read note review; do
  uvx --from skills-ref agentskills validate "docatlas/skills/$skill"
done
```

`read` can run independently. Stateful Skills share a session file; create one
for direct CLI use with:

```bash
export HARNESS_SESSION_FILE="$(uv run --locked docatlas init-session \
  --pdf document.pdf --tree-json trees/document_structure.json \
  --question 'What are the report conclusions?')"
```

See [the Skills guide](docatlas/skills/README.md) for direct invocation examples
and [ARCHITECTURE.md](ARCHITECTURE.md) for the Skill and session contracts.

## Preprocessing

Build the hierarchical PageIndex tree used by `search`:

```bash
uv run --locked docatlas build-tree \
  --pdf document.pdf \
  --output-dir trees/ \
  --model "$AZURE_OPENAI_DEPLOYMENT"
```

Build per-page Markdown and extracted figures with Docling:

```bash
uv run --locked docatlas build-md \
  --pdf document.pdf \
  --output-dir markdown/
```

The paper experiments use MinerU 2.5 output. Docling provides a convenient
local preprocessing path, but its extraction quality and benchmark results may
differ on dense tables, formulas, and complex layouts. Both are consumed through
the same per-page directory contract documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Multi-document questions

Build a merged tree, then pass each PDF to the chat command:

```bash
uv run --locked docatlas build-series-tree \
  --pdf reports/2024.pdf --pdf reports/2025.pdf \
  --output trees/annual_reports.json \
  --doc-name "Annual reports" \
  --model "$AZURE_OPENAI_DEPLOYMENT"

uv run --locked docatlas chat \
  --skill search --skill read --skill note --skill review \
  --pdf reports/2024.pdf --pdf reports/2025.pdf \
  --markdown-dir markdown/ \
  --tree-json trees/annual_reports.json \
  --message "Compare the principal risks reported in 2024 and 2025."
```

Use `--manifest` when documents need explicit `doc_id` or per-document
Markdown paths. `scripts/demo_end_to_end_multi.sh` provides a complete example.

## Evaluation

The MMLongBench runner uses a benchmark-specific response policy while normal
`docatlas chat` uses natural evidence-grounded answers.

```bash
bash scripts/run_eval.sh --limit 20 --n-jobs 4

uv run --locked python -m docatlas.scoring.score_mmlongbench_hybrid \
  --input outputs/mmlongbench_harness_TIMESTAMP.json \
  --model "$AZURE_OPENAI_DEPLOYMENT"
```

Evaluation outputs record the DocAtlas version, Git revision, model deployment,
API version, and `uv.lock` hash for reproducibility.

## Security and data handling

DocAtlas sends requested document content to the configured model endpoints and
stores session notes under `outputs/sessions/` by default. Review custom Skills
before loading them: Skill scripts are executable code, and DocAtlas is not an
operating-system sandbox. Treat PDFs, extracted Markdown, and document-tree text
as untrusted input.

Remote PDF support is limited to HTTP(S). Downloads use a private cache under
`outputs/tui/_downloads/`, are capped at 100 MB, and must pass both response-type
and PDF-header validation. Redirects are bounded; HTTPS downgrades, embedded
credentials, and hosts resolving to local, private, reserved, or non-routable
addresses are rejected. The raw TTY editor masks URL query values while they
are entered, and downloader status/cache metadata omit them. A URL supplied as
a command-line argument can still remain in shell history; paste sensitive
signed URLs into the opening screen instead. HTML pages are not accepted.

Please report vulnerabilities through the process in [SECURITY.md](SECURITY.md),
not through public issues.

## Development

```bash
uv sync --locked --extra dev
uv run --locked pytest
uv build
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Citation

```bibtex
@article{wei2026docatlas,
  title  = {{DocAtlas}: Long-Document Understanding as Mutable-State Interaction},
  author = {Wei, Hongchen and Wang, Yuanzhe and Liu, Bei and Yang, Yifan and
            Dai, Qi and Qiu, Kai and Li, Yunsheng and Chen, Dongdong and
            Luo, Chong and Chen, Zhenzhong and Guo, Baining},
  year   = {2026},
  note   = {Preprint}
}
```

## License and acknowledgements

DocAtlas is released under the [MIT License](LICENSE). The vendored PageIndex
snapshot retains its upstream MIT license and provenance under
[`docatlas/_vendor/pageindex/`](docatlas/_vendor/pageindex/).

DocAtlas builds on PageIndex, MinerU, Docling, verl, and vLLM. We thank their
authors and the creators of the long-document benchmarks used in the paper.
