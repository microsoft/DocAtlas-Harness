# _common — shared helpers for DocAtlas Skills

Not a SKILL. Holds code reused by multiple skill `scripts/run.py` entries.
Skill scripts import from it after putting `docatlas/skills/` on `sys.path`, e.g.
`from _common.markdown_reader import MarkdownReader`.

Modules:

| Module | Purpose |
|---|---|
| `pdf_text.py` | Extract per-page text from a PDF (PyPDF), with scanned-page detection. |
| `pdf_image.py` | Render PDF pages to base64 PNG (PyMuPDF). |
| `markdown_reader.py` | Read MinerU/Docling per-page markdown; linearize `![](…)` image refs. |
| `figure_filter.py` | Decide which figures are large/meaningful enough to surface. |
| `note_store.py` | Append-only progress-note store with a canonical JSON form. |
| `session_io.py` | Read/write the shared `session.json` (atomic tmp + rename). |
| `tree_ops.py` | Annotate and render the PageIndex tree (page-findings). |
| `llm_client.py` | Minimal Azure Responses API client for skills that need an aux LLM (Search, Review). |

Skills stay portable: nothing here imports from the agent runtime.
