# 完整 DocAtlas-Harness 实现审计

> 审计对象：`https://github.com/microsoft/DocAtlas-Harness.git` @ `6786a17a`。该 commit 与 2026-08-29 的 GitHub `main` HEAD 一致，并由 [sources.lock.json](../sources.lock.json) 固定在 `.sources/docatlas-harness`。

## 结论先行

完整仓库比早期局部实现成熟很多：已有可发布 Python package、165 个通过的测试、安全的远程 PDF 下载、原子预处理、四个可移植 Skills、多文档 workspace、Azure CLI 原生认证、连续对话 TUI 和只读 Overview。

但它仍然是一个**独立 Agent harness**，不是可直接嵌入 DSH 的 document library。正确迁移边界是：

- 复用文档读取、预处理、安全下载和 workspace 规划；
- 把 Search/Read 的业务语义改造成 DSH tools + Python sidecar methods；
- 把 Overview 的 immutable snapshot 思想改造成 DSH Web projection；
- 退役原 AgentLoop、Azure backend、prompt composer、TUI chat、JSON conversation/session transport；
- 用 Evidence/Claim/Provenance contracts 取代自由文本 Note 和 `page_findings` 事实层。

接入前有一个已经复现的 P0：多文档 tree enrichment 只按物理页码定位，`b.pdf / Page 2` 的 evidence 会写进遍历顺序更早的 `a.pdf / Page 2`。

## 1. 实际运行图

```text
CLI / TUI
  └─ create_agent_runtime
       ├─ SessionStore(session.json)
       ├─ SkillDispatcher
       │    └─ Search / Read / Note / Review subprocess
       ├─ AzureResponsesBackend
       ├─ composed system prompt + tool schemas
       └─ AgentLoop
            ├─ Responses previous_response_id chain
            ├─ function-call dispatch
            ├─ base64 → input_image promotion
            ├─ post-Note Read archival
            └─ post-Note tree annotation
```

| 上游模块 | 当前职责 | DSH 决策 |
|---|---|---|
| `docatlas/agent/loop.py` | 同步 Responses loop、tool dispatch、chain、image trim | 退役；DSH Agent Loop 接管 |
| `docatlas/llm/azure_responses.py` | Azure SDK、CLI/key auth、retry、response normalize | 作为兼容测试参考；DSH provider 接管主模型 |
| `docatlas/agent/dispatch.py` | argv-only Skill subprocess、env allowlist、JSON transport | 过渡期复用思想；稳定期由 SidecarSupervisor + typed protocol 取代 |
| `docatlas/skills/read` | PDF/Markdown/page image/figure 读取 | 高价值复用 |
| `docatlas/skills/search` | aux LLM 选 tree nodes | 保留输入/输出语义，LLM 调用迁入 DSH 可观测执行 |
| `docatlas/skills/note` | 自由文本 finding/evidence append | 只做 legacy importer；新写入改为 EvidenceAtom + ClaimVersion |
| `docatlas/skills/review` | aux LLM 选择 note cards | 由 Claim/Evidence 检索取代 |
| `docatlas/preprocess` | Docling Markdown、vendored PageIndex、merge | Sidecar 核心候选，但补 revision/generator identity |
| `docatlas/remote_pdf.py` | SSRF-safe PDF acquisition | 基本可直接迁移到 document provider |
| `docatlas/workspace.py` | 文档集合、cache plan、preprocess stages | 保留规划思想，替换 identity |
| `docatlas/ui/overview.py` | defensive immutable read model | 保留 projection 思想，不搬 ANSI UI |
| `docatlas/ui/*` | terminal picker/chat/overview | 退役；DSH Web slots 接管 |

## 2. Azure 实现与当前 endpoint

上游 `AzureResponsesBackend` 有两点做得正确：

1. 只读取 `AZURE_OPENAI_API_KEY`，不会把可能属于 `api.openai.com` 的通用 `OPENAI_API_KEY` 误发给 Azure；
2. 没有 Azure key 时使用 `AzureCliCredential` 和 Cognitive Services scope。

对本项目 endpoint 的实测结果：

| 路线 | 结果 |
|---|---|
| DSH custom `openai-responses` → `/openai/v1/responses`，Entra bearer | 200 |
| 上游 Azure SDK + `api-version=v1` | 404；SDK 仍构造旧 `/openai/responses` 路径 |
| 上游 Azure SDK + `api-version=2025-04-01-preview` | 200，返回 `DOCATLAS_NATIVE_AZURE_OK` |

因此当前两条可用路径都是真实的：DSH 使用 Azure v1 base URL；原 DocAtlas 使用根 endpoint + preview API version。不能只把原配置的 API version 改成 `v1`。

## 3. Agent Loop：能力与迁移判断

`AgentLoop` 已正确处理：

- `previous_response_id` 的增量 chain；
- tool-free response 作为 final answer；
- 最后一轮强制 `tool_choice=none`；
- tool argument JSON 容错；
- tool failure 回灌模型而不是结束进程；
- labelled page/figure images 升格成原生 `input_image`；
- image FIFO cap 与 re-chain；
- TUI 多问题 continuation；
- callback 失败不影响主流程。

但它不应迁入插件：

- 模型调用和 subprocess 都是同步阻塞；
- 运行中只能 interrupt，不能 steer/approve/resume；
- retry、tool timeout、cancellation、usage、session persistence 与 DSH 重复；
- server-side Responses chain 不可从 `session.json` 完整恢复；
- tool trace 只存在于当次 `AgentResult`，Overview 只保存 user/assistant 文本；
- Search/Review 的隐藏 aux LLM 不进入统一 DSH trajectory；
- prompt composer 重复叠加 strategy blocks 和完整 SKILL.md，增加固定 prefix 与策略冲突面。

## 4. 四个 Skills 的真实数据语义

### 4.1 Search

Search 把完整 tree、recent messages、read history 和 `page_findings` 交给一个低 effort aux LLM，让它返回 node IDs，再把 node page spans 展开成 `suggested_pages`。

优点：

- node ID 必须来自 tree，模型不能直接发明 page result；
- query、tree text 与 findings 被明确标为不可信输入；
- tree prompt 有 500k character hard cap；
- multi-doc 可以用 `doc_id` 限定 top-level document root。

缺口：

- Search 是另一笔隐藏模型调用，而不是普通 document computation；
- `search_history` 被记录但没有加入后续 Search prompt，`_history_hint()` 实际未被调用；
- history entry 不保存 `doc_id`；
- 未指定 `doc_id` 时，read-history 的 page number 会再次映射到遍历到的第一份 document；
- model JSON selection 只有宽松 parser，没有 schema-constrained output 或 verifier。

### 4.2 Read

Read 是当前最值得复用的垂直能力：

- 1-based physical page API；
- Markdown 优先、PyPDF fallback；
- Markdown 缺页时逐页回退 PDF；
- scanned PDF 自动 page-image fallback；
- full page image 与 extracted figure 分离；
- `(page, image_N)` figure addressing；
- 路径 confinement、扩展名/byte/pixel/page/figure limits；
- `doc_id` 到 PDF/Markdown 的 Host-side binding，不让模型选择任意路径；
- read history 正确携带 `doc_id`。

但 Read 输出仍不是 Evidence contract：没有 revision/content hash、quote selector、bbox、figure hash、generator version 或 resolved/unresolved 状态。`source=markdown|pypdf` 只是 extraction mode。

### 4.3 Note

Note 追加：

```text
found: string
plan: string
evidence[]: {type, source: string, content, filename?}
side_effect_policy
```

输入限制和 atomic save 是好的，但事实模型不足：

- `source` 只要求非空，自由字符串可伪造；
- 没有 document/revision identity；
- 没有与某次 Read result、quote hash 或 figure bytes 的链接；
- factual note 的 evidence requirement 主要靠 prompt，不由代码验证；
- `trace` 字段存在于 NoteStore，但 Note CLI 没有写入；
- finding、plan、evidence 和 side-effect policy 混在一个 mutable semantics 中；
- 没有 claim version、support/refute、conflict、review status 或 stale propagation。

### 4.4 Review

Review 只把最近 100 个 note cards（found、page refs、sources）交给 aux LLM选择，然后返回完整 note。它适合作为早期 memory compression，但不应成为 Claim Ledger 查询：没有 deterministic filter、embedding/index、fact status、scope、revision freshness 或 citation re-resolution。

后续设计不预设 Note/Review 必须继续充当 Memory 的写入/读取工具。它们的独立价值、组合方式、本地探针、
Tree update 优化和新 tool surface 选项见
[Note、Review、Memory 设计空间](15-note-review-memory-design-space.md)。

## 5. 已复现的 P0：多文档页码串线

merged tree 的每个 document root 都从 physical page 1 重新编号。`annotate_tree_from_note()`：

1. 从 `evidence.source` 正则提取一个 page number；
2. 丢弃 document identity；
3. 深度优先返回第一个覆盖该页码的 node。

只读复现输入为两个 roots：`D000/a.pdf` 与 `D001/b.pdf`，两者都有 Page 2；evidence 写着 `Page 2, metric from b.pdf`。实际结果：

```json
{
  "enriched_nodes": ["D000_0001"],
  "a_findings": ["B value"],
  "b_findings": []
}
```

这不是 title parsing 小问题。DocumentLocator 必须把 `documentId + revisionId + physicalPage` 作为一个原子 selector；legacy `Page N` 在多文档 scope 下必须 unresolved，不能默认第一份。

另一个同源问题是 `_explored_hint()`：未限定 document 的 read history 也只以 page number 回找 node，在 merged tree 中会把另一份文档的已读页映射到第一份文档。

## 6. Session 与持久化

上游 `session.json` 是单文件 snapshot：

```text
doc_env
notes
tree (session-local copy)
workspace.search_history/read_history/recent_messages/conversation
```

优点：private session directory、safe session id、temp + fsync + atomic replace、Skill subprocess 容易携带。

不适合 DSH 领域真相的原因：

- 无 `schema_version`、migration 或 compatibility gate；
- snapshot overwrite，不是 append-only provenance；
- 无 optimistic revision/transaction/lock；并发 writers 会 lost update；
- conversation 与 model chain 分离，restart 不能恢复 Responses chain；
- tree、notes、history 整体重写，文档稍大就放大 I/O；
- `session_patch` 只是 tool result annotation，没有被 runtime 应用为事件；
- action note 的设计注释说 Search 会追加 action，但当前 Search 只 tick counter。

DSH Session Log 应继续拥有对话与 Agent lifecycle；DocAtlas Investigation Journal 拥有 Evidence/Claim/Artifact 事实，两者通过 session/turn/step/call ID 交叉引用。

## 7. Preprocessing 与 workspace

### 可以复用

- Docling 每页 Markdown/figures 目录兼容 MinerU；
- 完整 page count 验证；
- staging directory 成功后才替换旧 artifact；
- tree JSON 和 build log atomic write；
- merged tree 给 node ID 加 `DNNN_` namespace；
- remote downloader 对 DNS/IP、redirect、HTTPS downgrade、size、timeout、PDF magic、symlink、permissions 和 query redaction 有完整防护；
- TUI workspace 把文档集合映射到 deterministic cache 目录。

### 必须补强

- workspace key 是 `resolved path + size + mtime_ns`，不是 content hash；
- direct `build-tree` 只凭 output filename 是否存在决定 cache hit；
- workspace metadata 只记录 PageIndex model，不记录 PDF hash、Docling/PageIndex version、OCR/vision/config hash；
- tree result本身没有 generator/provenance manifest；
- Docling 是方便的 CPU backend，论文 benchmark 使用 MinerU 2.5，二者 fidelity 不同；
- same-stem PDFs 被直接拒绝，DocumentId 仍依赖 filename convention。

目标模型应显式保存 `SourceRevision → SourceRepresentation(generator, version, configHash) → EvidenceAtom`。

## 8. TUI 的真实价值

TUI 不是一个应搬到浏览器的 UI，但提供了三个值得复用的产品抽象：

1. document selection 与 preprocessing workspace 分离；
2. `OverviewSnapshot` 是 defensive、immutable 的 read model；
3. Summary / Findings / Outline / History 是有效的信息架构。

不迁移 ANSI renderer、path picker、readline completion 和 terminal interrupt code。DSH Web 应把 snapshot 思想投射成 Library、Evidence Desk、Claim Ledger 与 Activity/Trajectory。同样，TUI 的 `/clear`、`/new`、`/rebuild` 语义应映射成显式 commands，而不是复用终端 command parser。

## 9. 测试现状

固定 checkout 使用现有 uv environment 完整运行：

```text
165 passed in 9.29s
```

强覆盖区域：TUI/path picker、remote PDF、terminal safety、Read/figure limits、CLI/session privacy、Agent loop basic chain、Azure retry、Overview projection。

缺失的迁移关键门：

- multi-document same-page annotation；
- evidence source 与实际 Read output 的关联；
- source revision / parser-version invalidation；
- concurrent session writers；
- crash/restart chain recovery；
- Note version/conflict/correction propagation；
- DSH tool event、browser slot 与 authenticated transport E2E。

“165 tests passing”说明上游基线稳定，不说明新的 DSH facts contract 已经成立。

## 10. 最终复用矩阵

| 处理方式 | 模块 |
|---|---|
| 直接复用/薄封装 | `MarkdownReader`、PDF text/image、FigureFilter、RemotePDFDownloader、merge tree namespace、atomic preprocessing helpers |
| 复用算法，重做 contract | Read、workspace planning、OverviewSnapshot、tree formatting |
| 保留为 legacy import | NoteStore、session tree `page_findings`、search/read history |
| 迁入 DSH Host | Search/Review 的 LLM judgment、tool schemas、approval/cancel/retry、model routing |
| 退役 | AgentLoop、AzureResponsesBackend 主路径、prompt composer、SkillDispatcher per-call process、TUI chat/renderer、conversation JSON snapshot |
| 新建 | DocumentRevision、SourceRepresentation、EvidenceAtom、ClaimVersion、EvidenceRelation、DerivationActivity、ArtifactManifest、Investigation Journal |

## 11. 修订后的实现顺序

1. 将本 commit 保持为 `.sources` 中的只读 upstream pin，不从原始 sibling checkout 编译；下游实验只进入
   本项目的独立 `DocAtlas-Harness/` Git 工作树，成熟后再形成可复现 package/patch。
2. M0 先修 DocumentLocator；给 legacy Note importer 增加 doc resolution，含糊多文档 citation 标 unresolved。
3. 在 upstream 或本项目 regression fixture 中加入两文档同页测试；未通过前禁止 tree enrichment 进入 DSH。
4. Sidecar 首个真实方法采用 Read 的 text/Markdown/page-image/figure core，不携带原 Agent Loop。
5. Host tool result 返回 bounded text + Evidence locator；大 image 走 authenticated binary fetch/attachment，而非 base64 JSON 长驻。
6. Search 由 DSH model-visible subtask/LLM capability执行并记录 trajectory，不让 sidecar 隐式调用 Azure。
7. Claim Ledger 稳定后再导入 legacy Notes；`page_findings` 只作为可重建 projection。
8. 最后实现 Web projection，借鉴 OverviewSnapshot 的防御性 fold，而不是移植 TUI。

## 12. 对当前 Azure Luna 测试的解释

`bash scripts/test-dsh-azure-luna.sh` 输出：

```text
DSH_AZURE_LUNA_OK
DSH Azure GPT-5.6 Luna smoke verified.
```

这是正确结果。额外的随机文件探针也证明 Luna 能经 DSH Responses function calling 读取工具结果并返回 nonce。它验证 DSH 模型链路，不验证 DocAtlas PDF pipeline；后者将由 Read sidecar vertical slice 单独覆盖。
