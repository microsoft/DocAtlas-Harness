# DocAtlas Progressive Read 实验记录

> 状态：Local spike，验证交互与结果体积，不是正式 wire contract  
> 日期：2026-08-30  
> 实验代码：本项目内独立的 `DocAtlas-Harness/` 工作树，分支 `docatlas-dsh/progressive-read`，基线 `b1e983a`（未提交修改）  
> 原则：仍然只有一个 `read` tool；用 `mode` 做渐进式 source access。

## 1. 要验证的问题

上游 Read 会把请求页面的完整 MinerU Markdown/PyPDF 文本拼进 tool result；`≤5 pages` 主要是 prompt
建议，默认 parser 上限实际为 50 页。它还缺少 block-level address，导致 Agent 只能从整页内容中手工
抄写自由文本 Note evidence。

本实验验证三个假设：

1. 不新增 tool，也能用 mode 完成 `locate → read → expand/visual`；
2. 候选预览和 aggregate budget 能显著减少模型可见 tool result；
3. deterministic block ID 足以先验证交互，但不能替代正式 revision-bound Locator。

## 2. 单一 Read 的五种 mode

```text
read(mode="locate")      lexical/structural block candidates + bounded previews
read(mode="blocks")      exact selected blocks under aggregate char/item budget
read(mode="expand")      one target block + page-local neighbours
read(mode="sequential")  every block in source order, paged by next_cursor
read(mode="visual")      requested page/figure pixels without repeated page Markdown
```

未传 `mode` 时保留旧的完整页面行为，因此现有调用、benchmark 和外部 Skill 使用者不会立即破坏。新 mode
继续要求显式 page scope，block ID 只能在当前 `doc_id + requested pages` 内解析。

## 3. 当前实现

### 3.1 Natural block layer

新增 `docatlas/skills/_common/block_reader.py`：

- 按 Markdown heading、空行、table、list 和 `[IMAGE image_N]` 生成自然 block；
- 超长自然块在约 2,000 字符的文本边界继续拆分；
- block ID 由 `doc_id + physical page + ordinal + source mode + kind + content hash` 确定性生成；
- 每个结果带 `page/kind/heading_path/content_hash` 和一个明确标为 `experimental` 的 locator；
- locate 使用无模型的 lexical/CJK-bigram/heading/visual-type signals，返回 matched terms 和 score；
- figure caption 仅作为候选检索附加文本，不会伪装成 source quote。

### 3.2 Bounded transport

新增参数：

```text
query, block_ids
max_items=8
max_chars=6000
preview_chars=240
context_before/context_after=1
cursor=0
```

`locate/blocks/expand/sequential` 不再同时返回 `pages[*].text`。`visual` 只保留 page identity、显式 page image
或 figure image；dispatcher 仍把 base64 从文本结果剥离并转成原生 image input。

DSH Web集成后来增加内部`page` mode：它按单个物理页、稳定block顺序和字符预算返回文本，并以绑定
representation+physical page的cursor续读。该mode只供authenticated Reader RPC使用，不出现在
`docatlas_read`的模型schema中。

Locate 只生成候选，不写 `read_history`，避免 Search 错把预览页面视作已完整阅读。Blocks、expand、
sequential 和 visual 只记录实际返回内容所在的页面和 mode。

### 3.3 Completeness escape hatch

Locate 的空结果明确写明 `does not prove absence`。对于 list、summary、contract four-corners 和 absence
claim，Agent 必须使用 `sequential` 并跟随 `next_cursor`，不能把 top-k candidate 当 coverage。

## 4. 已验证结果

新增 `tests/test_progressive_read.py` 六个测试函数，覆盖以下验证点：

1. locate 只返回 ranked previews，不泄漏无关整页文本；
2. 相同 representation 重复定位产生相同 block IDs；
3. blocks 返回 exact selected source block；
4. expand 正确标记 target 并返回前后邻居；
5. sequential 多次分页覆盖全部 blocks，无重复、无遗漏；
6. visual figure 返回一张目标图，模型文本中不重复出现该页 Markdown；
7. 其中一项同时经过真实 `SkillDispatcher`，验证 Agent JSON array → CLI argv → result 的完整路径。

测试 fixture 包含两页 Markdown、大量无关段落、目标财务段落、table 和 figure。体积 gate 要求 locate 的
模型可见输出小于 legacy full-page 输出的 25%，当前通过；这只能证明机制能缩小结果，不代表真实 PDF
上的 recall/latency/token 收益。

验证命令：

```bash
uv run --isolated --python 3.12.12 --extra dev --locked pytest
```

初始 spike 结果为 `171 passed`；加入 progressive TUI、显式空 `figures: []` 和错误传播后继续扩充回归。
最新修复明确区分了两种 picker 语义：由 composer 中临时 `@` 打开的 picker，Backspace/Delete 删除尚未
写入 buffer 的触发符并返回编辑；独立 picker 的 Backspace 仍然返回父目录；Esc 关闭 picker 后保留
普通文本 `@`。单元测试和真实 PTY 字节序列同时覆盖 Backspace (`0x7f`)、Delete (`ESC [ 3 ~`) 以及选入
`@path` 后的正常逐字删除。

修复后的完整 suite 在 Python 3.10、3.11、3.12.12 和 3.13 下均为 `180 passed`，合计 720 项；Ruff
check、format check、mypy、`git diff --check` 以及外层 DocAtlas-dsh 的 JS/plugin/sidecar 完整检查通过。

后续全面压力测试覆盖 435 次 Read CLI、6,052 blocks、24 路并发、22.5 MB 五页极限输入、2,000 个随机
query、Python 3.10–3.13 和 8 份真实 PDF。结果与暴露的性能/coverage 瓶颈见
[Progressive Read 全面压力测试报告](13-progressive-read-stress-results.md)。

## 5. 尚未解决

### 5.1 不是正式 Locator

实验 locator 只有：

```text
doc_id + physical_page + source mode + block_id + content_hash
```

仍缺 `documentId/revisionId/representationId`、TextQuote/TextPosition、PDF bbox、table cell、stable figure hash、
resolution status 和 cross-revision re-anchor。它不能进入正式 Claim Ledger 或 Published Artifact。

### 5.2 Relevance 还只是 baseline

当前 locate 在请求页内即时建 block，并用 lexical/heading signals 排序。它没有：

- persistent SQLite FTS5 index；
- alias/entity/query expansion；
- embedding/cross-encoder；
- block retrieval recall benchmark；
- 跨 Markdown/PDF text/OCR 的对齐。

这符合 spike 的透明、零隐藏 LLM 目标，但不能证明复杂语义问题的 top-k recall 足够。

### 5.3 尚未做真实 Agent/Evidence 闭环

- 还没有在 Azure Luna 的完整 Agent Loop 中比较 tool-call 数和 token；
- Agent 仍可使用旧 Note 自由填写 source/content；
- block result 还不能由 Core 物化为经过 quote/hash 复验的 EvidenceAtom；
- visual 仍使用上游 `(page, image_N)`，不是稳定 figure identity；
- 未测真实长表格、双栏、扫描件、OCR 错误和跨页 paragraph。

## 6. 下一步验证门槛

在把此机制迁入 `DocAtlas-dsh` sidecar contract 前，应做：

1. 选 10–20 份真实 PDF，建立 gold evidence blocks；
2. 比较 legacy、locate+blocks、sequential 三条路径的 output chars/tokens、latency 和 tool calls；
3. 报告 block recall@5/@10，不只报告最终回答；
4. 单独评估 list/absence tasks 的 sequential coverage；
5. 加入 alias、数字、table header、figure caption 和中英跨语言场景；
6. 固定正式 `DocumentLocatorV1` 后，让 block result 携带 revision-bound locator；
7. 实现 `locatorId + exact quote → Core re-resolve → EvidenceAtom`，拒绝无法在 source 中复现的 quote；
8. 再通过 DSH Agent Loop/Azure Luna 做端到端 A/B。

## 7. 当前判断

实验支持继续保留“一个 `docatlas_read`、多个 mode”的方向。它证明了渐进读取在当前 DocAtlas 架构中
不需要新增 Agent tool，也能兼容 legacy 行为并显著缩小 synthetic tool result。

实验尚未支持以下结论：lexical locate 足以替代全文阅读、block ID 已是 durable evidence locator，或最终
QA/citation 指标一定提升。因此它应作为 M0/M1 contract 输入，而不是直接合并为生产 Evidence 方案。
