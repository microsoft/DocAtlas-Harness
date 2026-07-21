# DocAtlas: Long-Document Understanding as Mutable-State Interaction

<p align="center">
  <img src="https://img.shields.io/badge/python-3.12-blue.svg" alt="Python 3.12">
</p>

<p align="center">
  <img src="assets/framework.png" alt="DocAtlas framework" width="100%">
</p>

## 🧭 What is DocAtlas?

> **DocAtlas turns a long document into _mutable state_ the model updates while it works.**
> Instead of retrieving from a frozen index, the agent searches a **living document tree**,
> reads pages selectively, writes source-grounded notes, and reviews them — and every action
> reshapes what later steps can find. The **same** environment powers strong inference-time
> VLMs **and** end-to-end RL for compact agents.

### ✨ Highlights

- 🌲 **Self-improving retrieval** — a document tree the agent *enriches as it reads*, so later search sees accumulated evidence (not a frozen index).
- 🎯 **Decoupled Search + Read** — high-recall *find* → selective, multimodal *consume*.
- 🧠 **Active working memory** — source-grounded Notes + on-demand Review under a fixed context budget.
- 🖼️ **Real multimodal reading** — full-page layout image + MinerU markdown + figure/chart crops.
- 🔁 **One environment, two regimes** — inference *and* end-to-end RL (tool use is *learned*, not prompt-scripted).
- 🏆 **Beats the human expert** on MMLongBench-Doc — with big gains across 3 benchmarks.

### 🧰 The four tools

|  | Tool | What it does |
|:--:|---|---|
| 🔎 | **Search** | Navigate the document tree → propose relevant regions (high recall) |
| 📖 | **Read** | Consume selected pages: layout image + markdown + figure/chart crops |
| 📝 | **Note** | Record source-grounded findings; write them back into the tree |
| 🔁 | **Review** | Recall the relevant prior notes on demand |

## 📊 Results

> 🏆 **GPT-5.4 + DocAtlas → 71.4%** on MMLongBench-Doc — **+9.0** over direct input, **+5.6 above the 65.8% human expert**.
> 🚀 **RL-trained Qwen3.5-4B → 63.7%** — a compact **4B** agent, **+9.3** over its 54.4% direct baseline.
> 📈 Biggest single jump: **FinRAGBench-V +20.5** (GPT-5.4).

Results across three long-document benchmarks (small ▲ = **gain over the same backbone's direct-input row**):

| Backbone | Setting | MMLongBench-Doc | FinRAGBench-V | LongDocURL |
|---|---|:---:|:---:|:---:|
| GPT-5.4 | direct input | 62.4 | 55.1 | 66.9 |
| **GPT-5.4** | **+ DocAtlas** | **71.4** 🏆 <sub>▲9.0</sub> | **75.6** <sub>▲20.5</sub> | **78.8** <sub>▲11.9</sub> |
| GPT-5.2 | + DocAtlas | 70.6 | 75.2 | 77.5 |
| Qwen3.5-4B | direct input | 54.4 | 52.8 | 52.4 |
| Qwen3.5-4B | + DocAtlas | 61.0 <sub>▲6.6</sub> | 67.9 <sub>▲15.1</sub> | 72.5 <sub>▲20.1</sub> |
| Qwen3.5-4B | **+ DocAtlas + RL** | **63.7** <sub>▲9.3</sub> | **71.7** <sub>▲18.9</sub> | — |
| Qwen3.5-9B | + DocAtlas + RL | 64.4 | 72.6 | — |
| _Human expert_ | _reference_ | _65.8_ | — | — |

<sub>MMLongBench-Doc = overall accuracy; FinRAGBench-V / LongDocURL = LLM-as-judge. RL rows omit LongDocURL (it is used to build the RL data). ▲ compares each DocAtlas row to the same backbone's direct-input row.</sub>

<details>
<summary><b>🔬 Ablations &amp; auxiliary-model robustness</b></summary>

<br>

Every component earns its place (MMLongBench-Doc, GPT-5.4, full = **71.4**):

| Remove… | Acc |
|---|:---:|
| full-page layout images | 65.7 |
| cropped sub-images | 67.2 |
| decoupled `Read` (consume Search hits directly) | 67.2 |
| `Note` / `Review` / evidence field / tree annotation | 67.8–68.3 |
| **nothing (full DocAtlas)** | **71.4** |

The frozen GPT-5.4 used inside `Search`/`Review` is **not** required: an open-weight
(Qwen3.5-35B-A3B) auxiliary loses only **0.3–0.4** points, and a fully self-hosted
auxiliary stays within **~2** points.

</details>

## 🔍 How it works

DocAtlas is built on three design principles (see the figure above and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation):

1. **🌲 Self-improving retrieval.** Each document is organized offline into a hierarchical
   **tree** (question-agnostic, built by a VLM using structured markdown + visual parsing of
   figures/tables/charts). `Search` navigates this tree; when the agent records findings via
   `Note`, those page-grounded findings are written *back* into the finest covering node, so
   later `Search` calls see accumulated evidence alongside the original summaries.
2. **🎯 Selective evidence access.** `Search` and `Read` are **decoupled**: `Search` proposes
   candidate regions (high recall), while `Read` gives the agent explicit control over which
   pages to actually consume — and in which modality. Each `Read` returns a full-page layout
   image, structured markdown (extracted by [MinerU](https://github.com/opendatalab/MinerU)),
   and cropped figure/chart sub-images.
3. **🧠 Active working memory.** `Note` records structured, source-attributed findings
   (`found`, `evidence`, `plan`) and can archive bulky read observations in place; `Review`
   selectively recalls prior notes. This lets the agent reason across many steps under a fixed
   context budget.

Each episode is a trajectory of tool calls over a mutable environment state
`S = (document, tree, note store, explored pages)`. The four tools have a fixed action space
but **no fixed execution order** — the agent may interleave search, reading, and memory
operations freely. Because this is a sequential decision problem, the identical environment
supports outcome-based RL (GRPO with DAPO-style asymmetric clipping; reward computed from the
final boxed answer with the LongDocURL type-aware score).

## 📂 Repository layout

- `DocSkills/` — portable SKILLs (`SKILL.md` + `tool.json` + CLI scripts) for
  **Search / Read / Note / Review**. Runtime-agnostic: consumable by this harness or any
  other LLM agent runtime, and never import from `harness/`.
- `harness/` — the agent kernel: skill loader, multi-turn agent loop, LLM backends,
  session state (document / tree / note store), and plain-text progress output.
- `profiles/` — runtime configs (which skills, which model, which options).
- `tasks/` — runnable jobs on top of the harness (preprocessing, batch evaluation).
- `scripts/` — top-level entry points (demos, eval reproducers).
- `scoring/` — scorers for MMLongBench-Doc and FinRAG outputs.
- `evals/` — per-skill regression evals.
- `vendor/pageindex/` — vendored [PageIndex](https://github.com/VectifyAI/PageIndex) (MIT).

## ⚙️ Installation

DocAtlas uses [`uv`](https://github.com/astral-sh/uv) for its venv and lockfile. From the
repo root:

```bash
# 1) create a clean 3.12 venv + install all deps from uv.lock
uv venv --python 3.12 .venv
uv sync

# 2) (optional) put the venv on PATH for the rest of the shell
source .venv/bin/activate
```

After `uv sync` the `harness` console script is available:

```bash
.venv/bin/harness --help          # or: .venv/bin/python -m harness --help
```

Copy `.env.example` to `.env` and fill in your **Azure OpenAI** endpoint + deployment.
Auth defaults to `AzureCliCredential` (run `az login` once) or set `AZURE_OPENAI_API_KEY`.
All model/deployment names are **required** (no baked-in defaults) — set
`AZURE_OPENAI_DEPLOYMENT` in `.env` and pass `--model` to the scorers.

<details>
<summary>Driving from a shell without the venv activated / heavy-dependency notes</summary>

<br>

Point at the venv explicitly:

```bash
export HARNESS_DRIVER_PYTHON=/path/to/DocAtlas/.venv/bin/python   # scripts + demos
export HARNESS_SKILL_PYTHON=/path/to/DocAtlas/.venv/bin/python    # SKILL subprocesses
```

- **Docling** (`build-md`): pulls layout + table + OCR models from HuggingFace on first run
  (~2 GB to `~/.cache/huggingface/`), then runs offline. `uv sync --extra gpu` adds a CUDA
  torch constraint (~3–5× faster `build-md`).
- **PageIndex** (`build-tree`): **vendored** at `vendor/pageindex/` (MIT; see
  `vendor/pageindex/UPSTREAM.md`). No extra install step. The loader prefers any importable
  `pageindex` over the vendored copy if you pin upstream yourself.
- **Skill aux LLM**: SKILLs that call an LLM (`Search`, `Review`) read
  `HARNESS_AUX_LLM_{ENDPOINT,API_VERSION,MODEL,API_KEY}` or fall back to `AZURE_OPENAI_*`.

</details>

## 🚀 Quick start

Run the end-to-end demo on the bundled, fully self-authored sample PDF:

```bash
bash scripts/demo_end_to_end.sh
```

This chains all three stages on one PDF so you can sanity-check the whole pipeline:

```text
PDF ──► build-md  ──► <doc>/<doc>_page<N>/vlm/<doc>_page<N>.md (+ images/)
   ──► build-tree ──► <doc>_structure.json
   ──► chat       ──► Search → Read → Note → Review → final answer
```

```bash
# Bring your own PDF + question
bash scripts/demo_end_to_end.sh --pdf /path/to/doc.pdf \
    --question "What is the maximum recommended dose of X?"

bash scripts/demo_end_to_end.sh --force        # force-rebuild md+tree
bash scripts/demo_end_to_end.sh --chat-only     # reuse cached artifacts, chat only
```

Outputs are cached under `outputs/demo/<doc_stem>/` so re-runs short-circuit completed
stages. The chat stage runs the 4-skill loop with live plain-text progress.

## 🔧 Preprocessing

### `harness build-tree` — PageIndex tree construction

Builds the `*_structure.json` files that `Search` navigates. Runs on your Azure-deployed
LLM; see `tasks/preprocess/build_tree.py` for full flags.

```bash
python -m harness build-tree \
    --pdf-dir data/MMLongBench/documents \
    --output-dir results/trees \
    --model <your-deployment> --node-summary
```

### `harness build-md` — per-page Markdown extraction (Docling)

Turns a directory of PDFs into the per-page markdown + figures layout that `Read` consumes
via `--markdown-dir`, backed by [Docling](https://github.com/docling-project/docling).

> **⚠️ Reproducing the paper?** The reported numbers were produced with **MinerU 2.5**, *not*
> Docling. This bundled `build-md` (Docling) is a **low-resource convenience path** so the
> pipeline runs end-to-end on a CPU-only box; its markdown is lower-fidelity on dense
> tables/formulas and **will not match the reported results**. To reproduce, extract markdown
> with [MinerU 2.5](https://github.com/opendatalab/MinerU) and point `--markdown-dir` at its
> output. Both backends emit the **same on-disk layout**, so nothing else changes.

<details>
<summary>On-disk layout &amp; more <code>build-md</code> examples</summary>

<br>

The shared on-disk layout (consumed by `DocSkills/_common/markdown_reader.py`):

```
<output_dir>/
  <doc_stem>/                       # PDF basename without `.pdf`
    <doc_stem>_page0/vlm/
      <doc_stem>_page0.md           # page markdown (figures as ![](images/picture-1.png))
      images/picture-1.png          # extracted figures
    <doc_stem>_page1/vlm/...
  build_md_log.json                 # per-doc latency / pages / images
```

```bash
# Single PDF / batch over a directory / only docs referenced by a samples.json
python -m harness build-md --pdf doc.pdf --output-dir markdown/
python -m harness build-md --pdf-dir data/MMLongBench/documents \
    --output-dir data/MMLongBench/markdown
python -m harness build-md --pdf-dir data/MMLongBench/documents \
    --output-dir data/MMLongBench/markdown \
    --samples-file data/MMLongBench/samples.json --only-sampled
```

`build-md` is idempotent (skips docs already extracted unless `--force`).

</details>

## 🔀 Multi-doc / cross-doc QA

For questions that span multiple PDFs ("compare the EN and FR editions", "across the
2018–2024 annual reports…"), the harness merges per-doc trees into one **series tree** and
routes each `Read`/`Search` call to the right doc via a `doc_id` parameter.

```bash
# (a) Merge N existing single-doc trees → series JSON
python -m harness merge-trees \
    --tree-files results/trees/ar2018.json results/trees/ar2019.json \
    --output trees/series/bis_2018_2019.json --doc-name "BIS AR 2018-2019"

# (b) One-shot: build trees for N PDFs then merge
python -m harness build-series-tree \
    --pdf docs/ar2018.pdf --pdf docs/ar2019.pdf \
    --output trees/series/bis_2018_2019.json \
    --doc-name "BIS AR 2018-2019" --model <your-deployment>

# Cross-doc chat (chat is multi-doc when --pdf is passed more than once)
python -m harness chat \
    --skill Search --skill Read --skill Note --skill Review \
    --pdf docs/ar2018.pdf --pdf docs/ar2018_fr.pdf \
    --markdown-dir markdown/ --tree-json trees/series/bis_2018_en_fr.json \
    --message "Compare how the EN and FR editions describe macroprudential policy."
```

Both tree builders accept a `--manifest <file.json>` (a list of
`{pdf | tree, title?, summary?, markdown_dir?}` objects) for per-doc overrides.
`scripts/demo_end_to_end_multi.sh` chains the whole multi-doc pipeline on a pair of PDFs.

## 🧪 Reproducing the paper

The benchmark corpora are **not redistributed** with this repo. Obtain them from their
sources and point the harness at them (again: use **MinerU 2.5** for markdown to match the
reported numbers).

A tiny, fully self-authored `data/sample_pdfs/sample_report.pdf` (regenerate with
`python data/sample_pdfs/make_sample.py`) ships so the demos and `Read` evals run without any
external corpus.

```bash
# Run the agent loop over MMLongBench-Doc with the paper's best config
bash scripts/run_eval.sh --limit 20 --n-jobs 4

# Score (LLM extraction + rule-based; pass your own --model), or --skip-extract for verbatim
python scoring/score_mmlongbench_hybrid.py -i outputs/<run>.json --model <your-deployment>
```

`scripts/run_eval.sh` encodes the paper's best inference config: 4 skills, `--detail high`,
`--vision-zoom 1.0`, high reasoning effort, `--max-turns 50`, memory off, tree-annotation on
(enabled automatically by the eval runner).

## 📌 Citation

If you use DocAtlas in your research, please cite:

```bibtex
@article{wei2026docatlas,
  title   = {{DocAtlas}: Long-Document Understanding as Mutable-State Interaction},
  author  = {Wei, Hongchen and Wang, Yuanzhe and Liu, Bei and Yang, Yifan and
             Dai, Qi and Qiu, Kai and Li, Yunsheng and Chen, Dongdong and
             Luo, Chong and Chen, Zhenzhong and Guo, Baining},
  year    = {2026},
  note    = {Preprint}
}
```

## 🙏 Acknowledgements

DocAtlas builds on excellent open-source work: the hierarchical tree index is inspired by and
vendors [PageIndex](https://github.com/VectifyAI/PageIndex); per-page markdown uses
[MinerU](https://github.com/opendatalab/MinerU) (paper setup) or
[Docling](https://github.com/docling-project/docling) (bundled fallback); and RL training uses
[verl](https://github.com/volcengine/verl) with [vLLM](https://github.com/vllm-project/vllm).
We evaluate on MMLongBench-Doc, FinRAGBench-V, and LongDocURL, and thank their authors for
releasing these benchmarks.
