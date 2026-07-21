# DocAtlas — Architecture

DocAtlas is a **document-understanding counterpart to Claude Code**: a
model-agnostic agent harness specialized for long-document, multimodal,
tree-structured PDFs. You control the agent loop, tool semantics, multimodal
returns, session state, and UI. Benchmark evaluation (MMLongBench-Doc,
FinRAG) is a *derived capability*, not the reason the harness
exists.

## Three layers

```
┌──────────────────────────────────────────────────────────────┐
│  DocSkills/   (portable, model- and harness-agnostic)        │
│  Search · Read · Note · Review   +   _common/ shared libs    │
│  Each skill = SKILL.md (LLM prose) + tool.json (schema)      │
│               + scripts/run.py (CLI, JSON over stdio)         │
└───────────────┬──────────────────────────────────────────────┘
                │  loaded by
                ▼
┌──────────────────────────────────────────────────────────────┐
│  harness/     (the kernel)                                    │
│  skill_loader → prompt_composer → agent/loop → llm backend    │
│  + session/ (shared session.json)  + ui/ (rich renderer)      │
└───────────────┬──────────────────────────────────────────────┘
                │  driven by
                ▼
┌──────────────────────────────────────────────────────────────┐
│  tasks/ · profiles/ · scripts/ · scoring/                     │
│  preprocessing (build-md / build-tree), batch eval, configs   │
└──────────────────────────────────────────────────────────────┘
```

Invariants:

- **DocSkills must not import from `harness/`.** That is what keeps them usable
  from Claude Code (via Bash), DocAtlas, or any other runtime. Shared code that
  a skill needs lives in `DocSkills/_common/`.
- **`harness/` depends on `DocSkills/`** through `skill_loader.py`.
- **`profiles/` and `tasks/` are harness-side only**; skills don't know about them.

## The SKILL contract

A skill directory has three parts:

```
DocSkills/<Name>/
├── SKILL.md      # YAML frontmatter (name, description) + free-form LLM prose
├── tool.json     # JSON Schema for the LLM-facing parameters
└── scripts/run.py  # the only CLI entry; reads args, writes one JSON object to stdout
```

- `SKILL.md`'s prose is handed to the model verbatim as part of the system
  prompt; its `description` and `tool.json` become the LLM tool schema.
- The CLI is the single execution path. Base output is `{"text": "...", ...}`.
  DocAtlas-only extensions are namespaced under `_harness_extras` (e.g.
  base64 `images`, a `session_patch`) so other runtimes can ignore them.
- **Session-level args** (the PDF path, the markdown dir) are bound once at
  launch and injected by the dispatcher — they are *not* in the LLM tool
  schema. **Per-call args** (pages, with_image, doc_id, …) are what the model
  chooses.

## The agent loop

`harness/agent/loop.py` runs the multi-turn loop:

1. **Compose** the system prompt (`prompt_composer.py`) from modular blocks
   plus each loaded skill's `SKILL.md` body; build tool schemas from each
   `tool.json`.
2. **Call** the LLM backend. On tool calls, the **dispatcher**
   (`agent/dispatch.py`) spawns each skill's `run.py` as a subprocess, injects
   session args + `HARNESS_SESSION_FILE`, and parses its JSON stdout.
3. **Multimodal returns** — if a skill returns base64 image URIs, the loop
   upgrades them into native `input_image` content blocks and appends them as a
   follow-up user message. The skill only ever emits JSON; the harness does the
   multimodal lifting (no disk round-trip). Old images are FIFO-trimmed to a cap.
4. **Chaining** — turns chain server-side via `previous_response_id` (Azure
   Responses API); only new items are sent each turn.
5. **Post-Note hooks** (`agent/post_note.py`) fire after a `Note` call:
   - *memory archival* replaces stale `Read` outputs with compact placeholders
     to free context (breaks the chain once to resend the trimmed mirror);
   - *tree annotation* lifts the note's page-findings into the PageIndex tree.
   Both are opt-in (`--memory`, `--tree-annotate`).
6. The turn with **no** tool call is the final answer.

## The four skills (+ two automatic hooks)

| Skill | Role |
|---|---|
| `Search` | Coarse filter: an aux LLM walks the PageIndex tree and returns candidate pages. |
| `Read` | The single content tool: page text (markdown or PyPDF), optional page screenshots, and figure sub-images. |
| `Note` | Append a structured progress note (found / plan / evidence). |
| `Review` | Recall saved notes relevant to a focused query (aux LLM). |

Memory archival and tree annotation used to be separate skills; they are now
**automatic post-Note hooks**, not model-visible tools.

## Session state

One JSON file per chat — `outputs/sessions/<uuid>/session.json` — is the single
source of truth shared between the harness and every skill subprocess. It holds
`doc_env`, `notes`, `tree`, and a `workspace`. Skills read/write it through
`DocSkills/_common/session_io.py` (atomic tmp-file + rename); the harness passes
its path via the `HARNESS_SESSION_FILE` env var. This makes skills
Claude-Code-compatible: set the env var and run the skill via Bash.

## LLM backends

The loop only knows the abstract `LLMBackend` protocol (`harness/llm/base.py`):

- **`AzureResponsesBackend`** (default) — Azure OpenAI Responses API, with
  API-key or `AzureCliCredential` auth and server-side chaining.
- **`CopilotChatBackend`** — any OpenAI-compatible `/v1/chat/completions`
  endpoint; translates the Responses-style items the loop builds into chat
  messages and keeps client-side multi-turn state.

`harness/llm/factory.py` picks the backend from config; adding a new backend
means implementing one method without touching the loop.

## Preprocessing & evaluation

- `build-md` (Docling) turns PDFs into the per-page markdown + figures layout
  that `Read` consumes; `build-tree` wraps vendored PageIndex to produce the
  `*_structure.json` trees that `Search` navigates. `merge-trees` /
  `build-series-tree` combine per-doc trees into one series tree for cross-doc QA.
  (Docling `build-md` is the low-resource extractor; the paper's numbers use
  **MinerU 2.5** — both emit the same on-disk layout, so the inference path is
  identical.)
- `tasks/mmlongbench/` drives the agent loop over a benchmark in parallel and
  emits a `{meta, results}` JSON that `scoring/` consumes. The runner writes the
  output schema; the scorers (rule-based + optional LLM extraction / judge) own
  the grading.
