# DocAtlas architecture

DocAtlas is a long-document agent harness built around explicit, inspectable
tool calls. The model locates evidence, reads only the required pages, records
grounded findings, and recalls those findings while the harness owns execution,
state, multimodal transport, and limits.

## Components

```text
docatlas/                  Single Python package namespace
  agent/                   Loop, dispatch, hooks, and trace events
  llm/                     Provider protocol and Azure Responses backend
  session/                 Atomic session state
  ui/                      Pipe-friendly progress rendering
  skills/                  Portable Agent Skills and shared runtime
    search/                Tree-guided candidate-page discovery
    read/                  Text, page-image, and figure retrieval
    note/                  Structured evidence checkpoints
    review/                Note retrieval
    _common/               Shared skill runtime
  preprocess/              PDF preprocessing and tree utilities
  benchmarks/mmlongbench/  Batch evaluation runner
  scoring/                 Benchmark scoring utilities
  _vendor/pageindex/       Frozen PageIndex snapshot
```

The dependency direction is deliberate: the runtime may consume Skills, but
portable code under `docatlas/skills` does not import agent-runtime modules.

## Skill contract

Each model-visible skill contains:

```text
docatlas/skills/<skill>/
├── SKILL.md               Agent Skills metadata and instructions
├── tool.json              JSON Schema for model-selected arguments
└── scripts/run.py         JSON-over-stdio CLI
```

The harness binds document and session context at launch. The model selects
only per-call arguments such as pages, query, figures, or evidence. Skill CLIs
write one JSON object to stdout. Harness-specific metadata is namespaced under
`_harness_extras` so another runtime can ignore it safely.

## Agent loop

For each model turn, `docatlas/agent/loop.py`:

1. Sends the system prompt, user request, and available tool schemas to Azure
   OpenAI's Responses API.
2. Dispatches requested skills as subprocesses without invoking a shell.
3. Returns textual tool results and promotes labelled base64 images to native
   multimodal input blocks.
4. Chains turns with `previous_response_id`.
5. Optionally archives earlier read results and enriches the session-local tree
   after a note.
6. Stops on a tool-free assistant response or the configured turn limit.

Interactive chat uses a general evidence-grounded response policy. The
MMLongBench runner explicitly enables its benchmark answer-format policy; those
grading instructions are not applied to normal harness users.

## Session state

Every investigation has a private session directory containing `session.json`.
It stores the document environment, notes, a session-local tree, and bounded
search/read history. Writes use a temporary file followed by an atomic replace.

The harness passes the path through `HARNESS_SESSION_FILE`. Direct callers can
create a compatible file with `docatlas init-session` and then invoke a skill
CLI themselves.

## Multimodal reads

The `read` skill prefers pre-extracted per-page Markdown when available and
falls back to PyPDF text. It can independently request:

- physical page images rendered by PyMuPDF;
- a metadata catalog of extracted figures; and
- selected figure pixels addressed by `(page, ref)`.

The Markdown root uses this zero-based on-disk page layout while Skill calls use
one-based physical PDF pages:

```text
<markdown-root>/<doc-id>/<doc-id>_page0/vlm/
├── <doc-id>_page0.md
└── images/
    └── picture-1.png
```

Image paths are confined to each page's `vlm/images/` directory and validated
before encoding. Page count, zoom, figure count, and image byte limits bound
model-selected work.

## Trust boundaries

PDFs, Markdown, tree summaries, and model-generated tool arguments are
untrusted inputs. Document content is labelled as evidence rather than
instructions. Skill subprocesses receive a reduced environment, and only the
built-in LLM skills receive Azure/OpenAI credentials.

Custom skill code is executable code and must be reviewed before loading. The
harness does not provide an operating-system sandbox; deployments processing
untrusted documents should add process/container isolation appropriate to their
risk model.
