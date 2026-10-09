> Historical DSH snapshot, archived on 2026-09-08. Not the current execution authority.
> See [current plan](../../implementation-plan.md) and [migration inventory](../../migration/dsh-to-core.md).
> Body preserved; relative Markdown links rebased for this archive directory.

# DocAtlas × DSH 完整实施主计划

> 文档状态：Canonical living plan
> 版本：0.2
> 对齐日期：2026-08-30
> 适用目录：`DocAtlas-dsh/`
> 当前执行状态：[执行任务板](execution-tracker-2026-09-01.md)
> 说明：本文件是后续实施、排序和验收的单一导航入口。`research/` 保留调研证据、方案推导和备选项；
> 如果旧路线文档与本文件冲突，以本文件标注的已确认决定和当前里程碑为准。未决项仍需 ADR 或 contract
> review，不能由实现代码静默决定。

## 1. 最终目标

DocAtlas 不是另一个 PDF Chat，也不是把现有 TUI 搬到浏览器。目标产品是：

> **一个 evidence-native、可累积、可个性化的文档研究 Agent：它使用 DSH 的 Agent Loop 与 Web shell，
> 共同阅读原文，把证据变成可追踪、可挑战、可复用的研究资产；新文档可以继续旧研究，同时系统逐步
> 学会用户怎样理解和核验材料。**

目标能力由五个支柱组成：

```text
1. Document Intelligence    结构导航、渐进读取、表格/图片/OCR、精确定位
2. Evidence & Fact Trace    Evidence、Claim、冲突、推导、Review、Artifact
3. Research Continuity      Note、Question、Decision、旧 Claim 与新文档的持续复核
4. Governed Personalization 偏好校准、工作流学习、why-used、可纠正和可遗忘
5. DSH-native Experience    唯一 Agent Loop、steering、approval、cancel、Web UI、replay
```

用户价值不是“生成更像用户口味的文字”，而是：

```text
更少重复说明
+ 更快回到原文证据
+ 更少重复核验
+ 更早发现变化、矛盾和遗漏
+ 每次研究都能形成以后可继续使用的可信资产
```

## 2. 当前状态基线

### 2.1 已完成

| 区域 | 当前成果 |
|---|---|
| 环境 | Node 22.19.0、pnpm 11.7.0、CPython 3.12.12、uv 0.9.21 固定并有检查脚本 |
| Source maintenance | DSH、DocAtlas、PageIndex SDK/MCP、ChatIndex 和社区插件均按 commit 固定在 `sources.lock.json` |
| DSH scaffold | Host/Client 双入口、manifest、build、publint、source compatibility probe 已通过 |
| Python sidecar | uv workspace、JSONL JSON-RPC health 协议、TS/Python protocol check 已完成 |
| Azure | GPT-5.6 Luna 的 Azure Entra 路由、DSH Agent Loop、filesystem tool loop 已验证 |
| Downstream DocAtlas | 独立 Git checkout、官方 `origin`、`docatlas-dsh/progressive-read` 分支 |
| Progressive Read | Agent仍使用`locate/blocks/expand/sequential/visual`五mode；sidecar另有不暴露给模型的`page` Reader primitive |
| Read 验证 | Python 3.10–3.13 每版 180 tests；435 次 CLI 压测、6,052 blocks、24 workers、8 份真实 PDF |
| TUI | progressive result 摘要、候选预览、`@` picker Backspace/Delete 行为已更新和回归 |
| X0 Tree containment | multi-doc legacy annotation 已 fail closed；多 Note/turn 与 failed Note hooks 已修复 |
| M1 supervisor | DSH subprocess、协商、双lane backpressure、bounded recovery、packaged runtime 与 Cordis lifecycle |
| M1 persistent index | PDF/Markdown ingest、稳定Block Map、SQLite FTS5、atomic generations、idempotency与质量评估 |
| M1 text document RPC | configuration-gated ingest/Search、四种text Read、bounded cursors与Locator resolve/re-anchor |
| M1 DSH tools | exactly two scoped tools、standard tool meta、structured errors与pinned cold projection restore |
| M1 authenticated assets | immutable original/page assets、authenticated Range/ETag、visual Read与scope revalidation |
| M1 single Loop E2E | real PDF、standard Search→locate→blocks events、cold projection、Azure GPT-5.6 Luna grounded answer |
| M2 SourceScope/RPC | per-session scope、authenticated channel、per-workspace journal/CAS、eligible-source与idle-Agent gates |
| M2 Library | opaque Host candidates、durable ingest jobs、PDF/Markdown、dedupe/revision、localized header drawer |
| M2 Evidence Desk | DSH原生三栏View、PDF页图+Locator文本轨、Markdown/纯文本、精确citation focus、双文档Compare |
| M2 focus/cursors | Host-authenticated Locator resolve、user/Agent双游标、follow状态、stale/ambiguous no-highlight |
| M2 answer trace | same-turn AnswerManifest、factual Segment、Agent-asserted relation、read-verified Evidence与gap action |
| M2 Source Scope Drawer | Host exact counts、current/historical分层、CAS delta、idle gate、DSH runtime-context projection |
| M2 atomic selection | exact re-resolve、structured composer reference、all-or-none pre-step claim与standard Session context |
| M2 selection actions | Ask intent + explicit EvidenceBookmark/ResearchNote/OpenQuestion/ClaimProposal journal writes |
| M3 Research Memory slice | schema v5 unified lifecycle、cross-Session FTS recall、exact Working/Research Tree Overlay、backup/restore gate |
| M4 Claim/Review/Publish | immutable ClaimVersion ledger、canonical Evidence relations、G0–G4 Review、human sign-off、Brief/Matrix Publish |
| M5 Research Continuity | append-only ContinuityLink、historical revision admission、signed revision-impact cursor、四类纵向安全场景 |
| M6 Governed Personalization | 独立 Profile ledger、bounded Decision/why-used、Probe、双开关、pause/edit/forget/export 与 Fact Trace non-regression |
| Product UI | chat-first DocAtlas 首屏与精简产品 profile 已接线；DSH Chat/Reader/Research 继续承载对话、原文、Claim/Review/Publish、Notebook/Continuity 与 Personalization |
| 设计 | DSH 架构、商业产品、PageIndex、Web 阅读页、Fact Trace、Memory、个性化和 Note/Review 均有专题记录 |

### 2.2 已进入产品主路径但仍有扩展空间

- Progressive Read、per-Session durable SourceScope、Library、authenticated browser RPC与Source Scope Drawer已经
  进入正式路径；eligible/included/used/cited/excluded可视化已完成，真实candidate provider/inbox仍待后期；
- block ID 是revision/representation-bound读取索引键；AnswerManifest只从同turn Read Locator生成provisional
  EvidenceAtom，不能直接把block ID或Search candidate当长期citation；
- Evidence Desk三栏shell已提供authenticated原始PDF、bounded Markdown/纯文本reader、dual cursor和Host-resolved
  citation focus；PDF已切换为authenticated PDFium页图+可选择block文本轨，Compare保持两套exact revision/page cursor；
- SelectionContext/RPC、Host stage/prepare/claim/commit和Client reference/tray已实现；selection可显式创建
  EvidenceBookmark/ResearchNote/OpenQuestion/ClaimProposal，Ask本身不产生领域写入；
- TUI与downstream实验仍只是验证场，不是未来Web UI实现；
- Web 默认入口不再暴露 DSH 的 workspace/session 管理页作为产品首屏：空白 Session 由 DocAtlas
  chat-first surface 接管；首次发送仍进入同一个 DSH Session/Agent Loop；历史、设置和工程诊断退到折叠侧栏；
- 产品 profile 隐藏 system prompt、token/耗时、模型/权限、Trajectory 等开发者展示，但不删除对应 Host
  生命周期或审计数据；citation、Library、Source Scope 和“原文”仍是用户可见主路径；
- 产品 Session 默认使用专属 `docatlas` Agent preset：不加载 `agent-instructions`、Bash、文件编辑、代码搜索、
  coding Skills 或 subagent 工具；DSH Loop、compaction、用户问题工具及 Host 注册的 DocAtlas Search/Read/Recall/Record
  保持可用。历史 `standard` Session 不热切换工具集，新会话才采用新 preset；
- 提交显式 `@document` 是用户对该文档的纳入动作：Client 必须在 Conversation send 之前，通过 Host opaque
  candidate 完成唯一解析、必要导入/索引刷新和 Source Scope CAS；零/多候选或任一步失败保留草稿且不启动 Agent；
- born-digital PDF 以可见行形成细粒度证据块；citation focus 只有在 PDFium 原始字符层唯一匹配并得到合法
  top-left ratio bbox 时，才在 authenticated 原始页图上突出。存在可信 PDF 高亮时派生文本轨不得同时标黄；
- M0–M6 的 identity、Selection、SourceScope、Library、Reader、Answer、Research、Claim/Review/Artifact、
  Continuity 与 Personalization 均已有 canonical schema、Host runtime 和相称的测试；高级 Studio、provider 与
  collaboration 仍按 M7 延后。

### 2.3 当前 release 明确未实现

- parser提供的可信PDF bbox/table-cell/figure-crop geometry与对应overlay；
- OCR/layout provider、remote document provider 和复杂表格/图片语义抽取；
- Timeline 等更多 Artifact Studio、team review、profile sync 与协作 ACL；
- 自动 source-ranking/reading-plan 个性化作用面；在真实用户纵向指标校准前继续保持关闭；
- M7 的 provider、Studio 与 collaboration，均不属于本 release。

### 2.4 当前仍需控制的已知风险

1. **Legacy 下游语义**：原 DocAtlas 的 page-only Note/hidden aux Review 只保留为 compatibility surface；正式产品
   只信 exact identity、typed journal 和 deterministic Review，不能把两者混用。
2. **Exhaustive amplification**：极大文档的全量 sequential 仍可能超出常见 turn budget；Agent 必须先 Search/locate，
   再 blocks/expand，并保留 cursor/budget。
3. **扫描/OCR**：真实扫描 PDF 会显式报告 empty/sparse；在 M7 provider 落地前不能伪造可检索正文或 bbox。
4. **历史来源可用性**：旧 revision 可以经用户 SourceScope CAS 显式纳入，但底层缓存/权限丢失时必须保持
   missing-source/unknown，不能用旧 Note 或缓存摘要替代。
5. **个性化过拟合**：当前只允许有限 effect 与 why-used；source ranking/reading plan 继续关闭，Probe 自动频率需
   真实 UX 数据校准。
6. **本地 profile 运维**：forget 能验证 DocAtlas-owned DB/WAL/backups/exports，但模型 provider 或外部导出副本只能
   给出 truthful non-deletion receipt。

## 3. 已确认的架构不变量

以下规则现阶段视为已确认，变更必须记录 ADR：

1. DSH 拥有唯一 Agent Loop、模型路由、Session Log、approval、cancel/steer 和 Web shell。
2. DocAtlas 不迁移 TUI 到 Web；Web 是全新的 document-first experience。
3. Python 是 document sidecar，不拥有第二个 Loop、conversation、个人画像或模型 credentials。
4. `contracts/` 是跨语言 wire/durable JSON 的唯一真相；TS/Python binding 必须与 schema 一致。
5. Source、Evidence、Claim、Artifact、Research Memory、Personalization Memory 是不同 domain。
6. Personalization 永远不能成为 EvidenceRelation 的 source，也不能改变 verifier/publication gate。
7. ResearchRecallLead、旧 Note 和旧 Claim 只是线索；用于新回答前必须 re-resolve/reverify。
8. 当前 source scope 不得被历史 Memory 或 Agent 静默扩大。
9. Canonical document tree 不被 Note/finding/personalization 改写；派生状态进入可重建 Overlay。
10. 浏览器只使用 DSH authenticated Connection/RPC/Fetch 和 opaque IDs，不能提交任意 server path。
11. 不创建 DSH 当前不接受的 custom Session event；领域状态进入 plugin-owned Investigation Journal。
12. 一个 `docatlas_read` 用 mode 支持渐进读取，不再为 locator/blocks/visual 各建一个 tool。
13. Note、Review、Memory 是正交能力，不按当前四个 Python Skills 的名字决定未来领域模型。
14. 简单任务允许只用 Read；不强迫每次回答写 Note、做 Review 或形成长期 Memory。
15. 所有 background model work 必须通过 DSH 可观察、可取消、可计费的执行路径。

## 4. 统一术语与状态域

### 4.1 四个状态世界

| 状态域 | 核心问题 | 典型对象 | 权威载体 |
|---|---|---|---|
| Source World | 原始材料具体说了什么？ | DocumentRevision、Representation、Locator、EvidenceAtom | source/blob/index store |
| Research World | 过去提出、核验、比较、决定了什么？ | Claim、Note、Question、Decision、Review、Artifact | Investigation Journal |
| Task World | 本次调查正在做什么？ | goal、plan、coverage、cursor、pending interaction | DSH Session + projection |
| Personal World | 用户通常怎样理解和研究？ | preference、familiarity、workflow、MemoryUse | Personalization ledger |

### 4.2 Memory 上位分类

```text
DocAtlas Memory Architecture
  ├─ Episodic Memory          DSH messages/tool trajectory
  ├─ Working Memory           current investigation plan/coverage
  ├─ Research Memory          evidence-linked research state
  └─ Personalization Memory   governed user adaptation state
```

关闭 Personalization 不关闭 Research Memory；关闭 cross-document continuity 也不删除或禁用用户的语言、
排版和 reader preference。

### 4.3 Note、Recall、Review

- **Note** 是用户熟悉的 capture/annotation 产品概念，可以创建 commentary、bookmark、hypothesis 或引导
  创建 OpenQuestion/Decision/Claim；它不是一张万能事实表。
- **Recall** 找到可能相关的 Working/Research state，返回 bounded leads。
- **Review** 是检查、挑战、比较、裁决与 sign-off 过程，不等于 Note retrieval。
- 当前 Python `Note/Review` 作为 legacy compatibility 和实验参考，不直接定义新 tool contract。

## 5. 目标运行架构

```text
DSH Runtime
├─ Agent Loop / models / Session Log / approval / cancellation
├─ authenticated Connection / Web shell / standard tool events
└─ docatlas-dsh plugin
   ├─ Host domain orchestration
   │  ├─ tool adapters
   │  ├─ source-scope and policy
   │  ├─ Investigation Journal
   │  ├─ Research Recall / Tree Overlay projectors
   │  ├─ Personalization Kernel
   │  └─ authenticated query/command/fetch
   └─ Client
      ├─ Library / Evidence Desk / Research Notebook
      ├─ Claim Ledger / Review Workspace / Studio
      └─ Personalization Center / tool views
             │
             │ versioned JSON-RPC + opaque IDs
             ▼
Python document sidecar
├─ ingest / preprocessing / provider capability
├─ DocumentRevision / representation metadata
├─ block map / FTS / PageIndex navigation
├─ progressive read / visual / OCR
└─ locator resolve / re-anchor support
```

### 5.1 推荐的物理所有权（需 ADR 固化）

| 能力 | 推荐位置 | 原因 |
|---|---|---|
| Agent Loop、模型调用 | DSH | 唯一可观察执行者 |
| Document providers、block index、render/OCR | Python sidecar | 贴近现有 DocAtlas/PageIndex/PDF 生态 |
| Domain policy、source scope、Review commands | TypeScript Host plugin | 紧邻 DSH events、Web auth 和 UI command |
| Investigation Journal | plugin-owned transactional SQLite | Claim/Note/Review/Artifact 需要事务、version、FTS、audit |
| Personalization ledger | profile-level、逻辑独立 SQLite | 与 workspace research retention/权限不同 |
| Stable profile projection | DSH storage-domain cache | 有界、同步读取；不是完整 ledger 真相 |
| Large pages/images/artifacts | private blob/cache store | 不进入 Session log 或 tool text result |

SQLite 是否同一文件分表，还是 profile/workspace 独立文件，必须在 Storage ADR 中用删除、备份、并发和迁移
原型决定；逻辑 schema 必须始终分离。

### 5.2 Journal 与 Session 的关系

```text
DSH Session Log                    DocAtlas Investigation Journal
user/assistant message             source-scope revision
tool call/result IDs  <----------> evidence/claim/note/review/artifact events
approval/cancel/steer              human UI decisions
turn lifecycle                     domain versions and projections
```

领域事务先 durable，tool result 再返回 IDs + hashes。DSH 有 result 但领域对象缺失属于 integrity error；
domain orphan 可以按 journal/session reference 回收。

## 6. 目标领域对象与 Contract 顺序

### 6.1 基础协议

```text
ProtocolVersion
ErrorEnvelope
Page/Cursor/Budget metadata
OpaqueResourceRef
ActorRef / Time / ProvenanceActivity
```

### 6.2 Source 与 Evidence

```text
DocumentRevision
SourceRepresentation
SourceScopeVersion
StructureNodeRef
DocumentLocator
EvidenceAtom
EvidenceResolution
SelectionContext
CitationPresentation
ViewFocusTarget
ProviderCapability
ToolResultMeta
```

`DocumentLocator` 最低需要：

```text
documentId + revisionId + representationId + physicalPage
+ blockId / TextQuote / TextPosition / bbox / table cell / figureRef
+ content hash + resolution status
```

### 6.3 Investigation 与 Research Memory

```text
Investigation
ResearchNote
OpenQuestion
ProjectDecision
ResearchPolicy
ResearchRecallLead
ContinuityLink
TreeOverlayEntry
CoverageSummary
```

### 6.4 Claim、Review 与 Artifact

```text
ClaimVersion
EvidenceRelation (support/refute/qualify)
DerivationActivity
AnswerManifest / AnswerBlock / AnswerSegment
ReviewIssue / ReviewResult / ReviewDecision
ArtifactManifest / ArtifactSection / ClaimUse
VerificationSummary
```

### 6.5 Personalization

```text
PersonalizationSessionPolicy
PersonalizationObservation
MemoryCandidate
MemoryVersion
PersonalizationDecision
MemoryUse / Outcome
PreferenceProbe / PreferenceChoiceObservation
```

Contracts 按里程碑加入，不在 M0 一次冻结所有未来对象。每个新 schema 必须同时有：canonical examples、
invalid fixtures、TS/Python parser parity、version negotiation 和 migration/unknown-version behavior。

### 6.6 五级 Verification Gates

```text
G0 Integrity    locator/revision/hash/object existence 可以解析
G1 Grounding    每个 factual Claim 有足够 support，引用确实支持对应 span
G2 Scope        source scope、时间、定义、jurisdiction 和 coverage 符合任务
G3 Conflict     materially conflicting evidence 已寻找、连接并披露
G4 Publication  Artifact 的 claim uses、policy、human review/sign-off 达标
```

Explore 可以保留 proposed/unresolved Claim，但 UI 必须标明；Publish 必须依次通过 gates，不能因为模型给出
了流畅结论或格式正确的 citation 而跳过。

## 7. Agent tool、Host command 与 query surface

### 7.1 推荐 Agent tools

| Tool | 阶段 | 职责 |
|---|---|---|
| `docatlas_search` | M1 | Tree/FTS/navigation，返回候选 node/page/reason，不返回整文档 |
| `docatlas_read` | M1 | 单一 source access tool：locate/blocks/expand/sequential/visual |
| `docatlas_record` | M3 | 提交 typed checkpoint/ClaimPatch/OpenQuestion proposal，不直接绕过 policy |
| `docatlas_recall` | M3/M5 | 查询 Working/Research state，返回 bounded leads、status 和 cursor |
| `docatlas_verify` | M4 决策 | 启动 Claim/Artifact review；是否独立 tool 由 vertical slice 决定 |
| `docatlas_publish_brief` | M4 | 提交结构化 ArtifactManifest，触发 deterministic gates |

不增加泛化 `memory(action=...)` 万能 tool。Personalization stable profile 可由 Host pre-step 注入；Agent 需要
主动 recall 时只能读取有界 decision/lead，不能直接编辑 active profile。

### 7.2 不应成为模型 tools 的用户命令

- accept/edit/reject evidence 或 claim；
- confirm/pause/forget/export personal memory；
- Preference Probe choice；
- source-scope inclusion；
- policy/waiver/sign-off；
- delete/archive/re-anchor；
- layout、reader、follow、panel preference。

这些操作走 authenticated Host commands，产生可审计 domain events。

### 7.3 Tool result 规则

- text result 必须有 `max_items/max_chars/next_cursor/truncated/completeness`；
- large source/artifact 使用 ID + authenticated binary fetch；
- tool meta 只放 IDs、hashes、locator summaries 和可 fold projection；
- model-visible preview 明确标 candidate/lead，不可作为 evidence；
- 每个错误告诉 Agent 可执行的下一步，不返回空 stderr 或模糊失败；
- cancellation 后外部状态未知时必须 resolve，不可假定成功或失败。

### 7.4 可交互 Agent 执行协议

```text
0 Scope       明确问题、source、strictness、预算、输出形态
1 Plan        拆子问题和 coverage，不展示隐藏 chain-of-thought
2 Recall      有界 Working/Research/Personalization leads
3 Observe     Search/Read current and approved prior sources
4 Claim       形成 atomic proposed claims 和 evidence relations
5 Challenge   找反证、缺口、口径、时间和版本冲突
6 Synthesize  组织符合当前 mode/gate 的 answer/artifact
7 Review      deterministic checks、Agent patch、human decision
8 Record      journal、continuity、memory use/outcome
```

用户只在会改变边界或承担高风险的 checkpoint 被打断：source/permission 变化、高成本计划、重大冲突、
长期 personal memory 写入、Publish/sign-off、external side effect。普通导航通过轻量 steering：点击 source、
node、claim、evidence 或 plan action 直接影响下一步，不重启整个 investigation。

UI 显示 goal/subtask、source scope、当前 action、agent cursor、evidence/claim/coverage、open questions、预算、
暂停原因和结果；不显示隐藏推理链。Cancel 后若外部写入状态不明，进入 resolve 状态。

若后期启用 subagents，只按 document/question branch/support-vs-counterevidence 并行；child 返回 typed
Evidence refs、Claim patches、OpenQuestions 和 CoverageSummary，root Agent 保持唯一用户交互和 Publish owner。

## 8. Progressive Document Core

### 8.1 保留的五种 Read mode

```text
read(mode="locate")      query-conditioned candidate blocks + bounded previews
read(mode="blocks")      exact selected blocks under aggregate budget
read(mode="expand")      one target + page-local neighbours
read(mode="sequential")  source-order coverage windows + next cursor
read(mode="visual")      page/figure pixels without repeated Markdown
```

Legacy full-page mode只用于兼容，DSH 产品默认使用 progressive path。

### 8.2 从 spike 到生产的必做项

1. ingest 时生成 version-bound Block Map、normalized fields、content hashes；
2. SQLite FTS5/exact key baseline，query time 不重复切 22.5 MB 文本；
3. formal Locator 与 block → quote/position/bbox/table/figure mapping；
4. locate recall benchmark：中英、数字、alias、table header、caption、cross-language；
5. sequential 将相邻短 block pack 成 coverage span，降低 122-call amplification；
6. `text_quality = empty/sparse/garbled/usable`，决定 OCR/visual fallback；
7. provider capability、generator version/config hash 与 derived-from lineage；
8. cancellation、concurrency、restart、corrupt cache、schema migration；
9. visual 的 page/figure count、zoom、pixel、byte 和 content-type limits；
10. output token/char/latency telemetry，不记录 source secret 内容。

### 8.3 Search/Tree

```text
Canonical Tree                 immutable structure per representation
Working Coverage Overlay       current session reads/cursors
Research Overlay               Claim/Note/Question/Review/Artifact refs
Personalized Lens              turn-bound rank/presentation hints
```

Search 先执行 doc/revision/scope/status filter，再结合 canonical structure、FTS 和 active overlay；必须保留
non-history/non-personalized exploration quota。回答仍由 Read 获取 exact blocks，不能把 Tree summary 当证据。

## 9. Web 文档体验

本节是执行摘要；逐 claim-span citation、focus state machine、多文档组织、selection toolbar/context tray、
12 类业务场景、DSH slot/RPC、失败态与 UI0–UI7 详见
[Web UI 全景设计](../../../research/16-web-ui-interaction-design.md)。

### 9.1 七个产品面

1. **Library**：导入、collection、provider、revision、source role、权限与处理状态。
2. **Evidence Desk**：Document Atlas / Original Source / Investigation 三栏共同阅读。
3. **Research Notebook**：Note、Question、Decision、Related prior work 和 continuity。
4. **Claim Ledger**：atomic claims、support/refute、conflict、coverage、history。
5. **Review Workspace**：issues、checklist、diff、patch、waiver、sign-off。
6. **Evidence Studio**：从 pinned ClaimVersions 编译 Brief、Matrix、Timeline 等 artifact。
7. **Personalization Center**：preference、candidate、probe、why-used、pause/forget。

M4 的 Evidence Studio 首版只做 Brief 与 Matrix，其他 artifact 后续扩展。Activity/Trajectory 继续由 DSH
提供，不成为另一份 DocAtlas 事实状态。

### 9.2 Evidence Desk 基础布局

```text
┌──────────────────────── DocAtlas header ────────────────────────┐
│ source scope / search / page   PDF bitmap + text | Compare A/B │
├──────────────┬──────────────────────────────┬───────────────────┤
│ Documents +  │ Original PDF / extracted     │ Investigation     │
│ Outline      │ text / table / figure        │ Claims/Evidence   │
│ user+agent   │ selection + locator          │ prior work/why    │
│ cursors      │                              │ personalized      │
├──────────────┴──────────────────────────────┴───────────────────┤
│                  DSH native composer                            │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 关键交互不变量

- user cursor 与 agent cursor 分离，Agent 默认不抢用户滚动位置；
- citation 一次点击定位 exact document/revision/page/block/exact quote；只有provider给出真实bbox后才绘制区域框；
- selection 以 nonce/atomic context 与下一条 direct user message 绑定；
- selection toolbar：问 Agent、保存摘录、写评论、提出问题、形成主张、找反例、对比；
- PDF页图是视觉权威，提取文本轨用于选择/定位并显示quality/provider边界；扫描页无文本时不伪造段落；
- Compare的A/B各有document+revision+page cursor，绝不按相同页码自动对齐；窄屏只切换视图、不复制状态；
- Sources、Related prior work、Why personalized 使用不同视觉与导航；
- browser 永远不接收任意 server filesystem path；
- responsive、keyboard、screen reader、44px touch、reduced motion 从首版纳入。

### 9.4 初始性能预算

- cached citation focus p50 < 200 ms；
- local first page p95 < 1.5 s；
- page canvas/bitmap 使用 bounded LRU；
- tree/claims/notes 分页和 lazy load；
- tool text 不包含 base64 或整页 PDF；
- narrow/mobile layout 不复制另一套 state model。

预算在真实 browser probe 后调整，不能当尚未测量的承诺。

### 9.5 三种产品模式

| Mode | 用户目标 | 允许状态 | 必需门槛 |
|---|---|---|---|
| Explore | 快速理解、追问、漫游 | proposed/unresolved Claim | source-grounded，明确不确定性 |
| Verify | 数字、合同、跨文档差异、重要判断 | support/refute/qualify/conflict | Scope、Grounding、Challenge、coverage |
| Publish | 可交付 brief/matrix/report | pinned reviewed ClaimVersions | G0–G4、policy、必要 human sign-off |

Mode 可以由用户选择或 Agent 建议，不能因个人偏好把 Verify/Publish 自动降级。Explore answer 不是 Published
Evidence Brief；后者是明确动作和 versioned Artifact。

## 10. Note、Recall 与 Review 计划

### 10.1 Note

Note 允许无 Evidence，但必须有明确 epistemic type：bookmark/commentary/hypothesis/scratch。形成 factual
Claim 时强制 EvidenceAtom。用户从统一 Note UI 发起的 OpenQuestion、Decision、Claim 应落入各自 schema，
不继续塞进万能 Note record。

### 10.2 Recall

首版使用 exact key + FTS5 + structured filter；输入含 domain/scope/status/time/max_items/max_chars/cursor。
输出是 Working/Research lead，不是重新包装的旧事实。Evidence-only object 必须可检索；无 match 是合法
abstention。

### 10.3 Review

Review 分三层：

```text
deterministic integrity/coverage checks
→ DSH-visible Agent challenge and evidence search
→ human accept/edit/reject/waive/sign-off
```

优先 modes：answer-coverage、claim-challenge、document-diff、note-hygiene、memory-refresh、policy-check、
publish-gate。ReviewResult 结构化保存 checked IDs、issues、patches、coverage、decision、reviewer 和 time。

### 10.4 旧 Note/Review 迁移

- 旧 factual Note 没有可解析 refs 时导入 `unverified`；
- 当前 Review 语义迁为 `recall` compatibility adapter；
- `page_findings` 只作为 legacy rebuild input，不进入 canonical tree；
- 多文档 tree annotation 在身份修复前默认关闭；
- post-Note archive 只处理被 evidence 明确覆盖的 call IDs，长期由 DSH context management 接管。

## 11. Research Memory 与 Continuity

### 11.1 运行路径

```text
current question + explicit source scope
→ current Search/Read
→ ResearchRecallLead candidates
→ scope/freshness/provenance gate
→ user confirms source inclusion when required
→ old locator re-resolve + Read exact blocks
→ compare/challenge current and prior evidence
→ answer labels continuing/changed/conflicted/unknown
→ ContinuityLink + Claim/Question/Artifact updates
```

### 11.2 首版范围

- 同一 workspace；
- typed Claim/Note/OpenQuestion/Decision/Artifact；
- suggest-only related prior work；
- source-scope confirmation；
- stale/superseded/missing-source 状态；
- Research Notebook 与 Tree Research Overlay；
- current revision impact on old Claim/Artifact。

跨 workspace、provider、team/global history 等身份、权限和 retention 稳定后再开放。

## 12. Personalization 具体方案

### 12.1 闭环

```text
explicit setting / Preference Probe / correction / UI action
→ PersonalizationObservation
→ deterministic aggregation or DSH-visible extraction
→ MemoryCandidate
→ policy + confirmation
→ active MemoryVersion
→ recall admission
→ bounded PersonalizationDecision
→ DSH/UI action
→ MemoryUse + Outcome
→ correction / supersession / forget
```

### 12.2 第一版学习范围

- answer order：结论优先 / 证据优先；
- explanation depth：brief / standard / teaching；
- evidence presentation：quote / table context / visual context；
- reader：PDF / Markdown / comparison；
- terminology familiarity；
- artifact format：brief / matrix / timeline。

后期才允许影响 source order、reading workflow、challenge depth 和 negative lesson；Fact Trace gate 通过前
不得影响 evidence selection/verifier。

### 12.3 写入准入

| 信号 | 默认处理 |
|---|---|
| 设置页显式选择 | 低风险 preference 可直接 active，支持 undo |
| 用户明确“以后默认”并选择 scope | active version |
| 普通 Preference Probe choice | observation；一次选择不自动 global |
| 重复 steering/edit + 正向 outcome | candidate，等待确认或保守 promotion policy |
| Note/Review outcome | 可作为有 provenance 的信号，不是必需入口 |
| Agent 自己的回答 | 不可成为用户偏好证据 |
| PDF/Web/tool output | 不可直接进入 Personal Memory |
| secret/高影响敏感推断 | 拒绝或独立 opt-in |

### 12.4 Recall 与 Decision

先做 profile/workspace/task/sensitivity/consent/status/time hard gates，再用 exact/FTS relevance 和 utility。
输出只能是 bounded effect enum，例如：

```text
preferredRepresentation
explanationDepth
evidencePresentation
sourceOrder
challengeDepth
artifactFormat
```

每个 decision 带 why、memory version IDs、turn expiry 和 invariants：不得改变 support、隐藏 contradiction
或放宽 publication gate。

### 12.5 Preference Probe

两个 renderer 必须共享相同 SourceScope、Claim、Evidence、uncertainty 和 conflict set，只改变一个变量。
左右顺序随机化，支持 both/neither/dismissed，并让用户选择 turn/workspace/task-family/global scope。

“用户喜欢”与“任务更有效”分别记录：choice 进入 Observation，time-to-evidence、纠正、Review 完成和
miss 等进入 MemoryUse outcome。

### 12.6 控制面

```text
useExistingPersonalization
contributeToFuturePersonalization
recallPriorResearch = off | suggest | auto-within-explicit-scope
contributeResearchState
```

Temporary 模式关闭两类 contribute；用户也可以“使用偏好但只看当前文档”或“使用旧研究但本次不学习”。

## 13. 实施里程碑与依赖

```text
F0 Foundation [complete]
   │
X0 Downstream hardening
   │
M0 Identity & contracts
   │
M1 DSH Read vertical slice
   │
M2 Evidence Desk
   │
M3 Investigation capture/recall + Tree Overlay
   │
M4 Claim/Review/Publish
   │
M5 Research Continuity
   │
M6 Governed Personalization
   │
M7 Providers/Studio/Collaboration

Parallel personalization foundation:
K0 domain/contracts ─ K1 observations ─ K2 explicit prefs ─ K3 probes/candidates
       M0                 M1/M2              M2/M3             M4/M5
                                      └──────────► K4 adaptation at M6
```

### F0：可复现基础（已完成）

交付：固定环境、source pins、plugin/sidecar scaffold、health protocol、build/test、Azure Luna smoke。

Exit：`bash scripts/check.sh`、manifest/compat/protocol checks 和 opt-in Luna test 已通过。

### X0：下游实验固化与风险控制（当前）

任务：

1. 整理 progressive Read、TUI 和测试为可审查下游变更；
2. multi-doc 下关闭或修复旧 Tree annotation；
3. 给 Note/Review/Tree 已复现边界补回归测试；
4. 固定 Python 3.10–3.13 matrix 和 stress artifact；
5. 比较当前 Microsoft upstream，记录 rebase/cherry-pick 冲突；
6. 明确哪些实验迁入 sidecar，哪些仅保留参考。

Exit：下游 branch clean/reproducible；无已知 wrong-document write；所有实验结果与代码 revision 对齐。

### M0：Identity、Locator 与核心 contracts（已完成）

任务：

1. 签 Runtime Ownership、Identity/Locator、Storage/Journal ADR；
2. 实现 DocumentRevision、Representation、SourceScope、Locator、EvidenceAtom、protocol errors；
3. TS/Python bindings 与 cross-language fixtures；
4. legacy Note/page finding importer 只产 unresolved/unverified；
5. 双文档同页、revision replacement、quote/bbox conflict、stale locator tests。

Exit：任何 Evidence 均可唯一解析 document + revision；多文档同页不串线；无法解析时 fail closed。

### M1：DSH + sidecar Progressive Read 纵向切片

任务：

1. sidecar lifecycle/start/health/shutdown/restart/cancel；
2. ingest、Block Map/FTS、Search 和五种 Read mode RPC；
3. Host 注册 `docatlas_search/read`；
4. standard tool events + ToolResultMeta + cold projection；
5. authenticated PDF/asset fetch 和 Range probe；
6. Azure Luna `search → locate → blocks → answer` E2E；
7. structured error、char/image/page/latency limits。

Exit：本地 PDF 和多文档可以通过 DSH 唯一 Loop 完成问答；cold replay 可恢复 Tool 状态；无 Python Loop。

### M2：Evidence Desk 与 selection → Evidence

任务：

1. Library + three-pane Evidence Desk；
2. PDF bitmap+text rail/Markdown reader、dual cursors、follow states；
3. citation focus 与 stale/ambiguous fallback；
4. AnswerManifest/Segment/CitationPresentation，让每个 material factual span 映射 Claim/Evidence；
5. Source Scope Drawer，区分 eligible/included/used/cited/excluded/candidate；
6. atomic SelectionContext + DSH context tray，支持 text/table/figure/multi-range；
7. selection 创建 EvidenceAtom/Note/OpenQuestion/Claim proposal；
8. Library、single-reader、双文档Compare和基础多文档组织；Series仍属后续增强；
9. responsive/accessibility/security/performance；
10. 10 类真实 PDF browser E2E。

Exit：PDF/Markdown 能回到同一 Evidence ID；真实 answer 的每个 factual segment 可跳到正确
document/revision/paragraph/table/figure；无 wrong-page/wrong-document highlight；selection 不会附错消息；
用户和 Agent 阅读位置互不抢占。

### M3：Investigation capture/recall 与 Tree Overlay

任务：

1. Investigation Journal SQLite + migration/backup/recovery；
2. ResearchNote/OpenQuestion/ProjectDecision/ResearchPolicy；
3. `docatlas_record/recall` + FTS/budgets/cursors；
4. Working/Research Overlay projector，canonical tree immutable；
5. Note UI、Research Notebook、Related prior work suggest-only；
6. legacy Note/Review compatibility adapters；
7. cross-session current workspace recall。

Exit：一条 selection/Note/OpenQuestion 可跨 session 召回并回原文；correction/delete 能撤回 Tree hint。

### M4：Claim Ledger、真实 Review 与 Publish

任务：

1. ClaimVersion、EvidenceRelation、Derivation、statuses；
2. Claim Ledger、Contradiction Inbox、Coverage View；
3. deterministic gates + DSH Agent challenge + human review；
4. answer coverage、claim challenge、document diff、publish gate；
5. Brief + Matrix ArtifactManifest；
6. one claim → two evidence → conflict → human decision → published brief。

Exit：每个 published factual span 映射 ClaimVersion；citation precision/completeness/scope/conflict gates 通过。

### M5：Research Memory 与版本连续性

任务：

1. ResearchRecallLead、ContinuityLink、recall-to-reverify；
2. source inclusion confirmation；
3. new revision impact analysis 和 stale propagation；
4. Continue OpenQuestion、Changed since last time；
5. financial/contract/research/audit longitudinal scenarios；
6. prior-work recall quality 与 cross-scope safety eval。

Exit：新文档能安全关联旧研究，并准确标 continuing/changed/conflicted/unknown；旧 Note 不会自证。

### M6：受控个性化激活

K0–K3 在此前并行完成。本阶段扩大实际作用面：

1. Personalization Center 和双开关；
2. explicit preferences + bounded PersonalizationDecision；
3. Preference Probe 和 candidate/version lifecycle；
4. why-used、pause/edit/forget/export；
5. task-conditioned reader/answer/evidence presentation；
6. 在 Fact Trace non-regression 后逐步开放 reading plan/source order/challenge depth；
7. longitudinal users、drift、poisoning、incognito、delete eval。

Exit：个性化减少重复 steering/time-to-evidence，且 factual/citation/conflict metrics 不下降。

### M7：Provider、Studio 与协作

候选：OCR/layout providers、remote document sources、更多 Artifact、team review、profile sync、协作权限。
任何外部 provider 必须有 capability、data boundary、retention 和 failure policy；团队/同步必须先解决 actor
identity、ACL、delete/export 和 migration。

## 14. ADR 清单

| ADR | 决定 | 最迟阶段 |
|---|---|---|
| [ADR-001](../../adr/001-runtime-ownership.md) Runtime ownership | DSH/Host/Python 的最终职责与调用方向 | M0 |
| [ADR-002](../../adr/002-document-identity-and-locators.md) Document identity & Locator | revision、representation、selector、re-anchor | M0 |
| [ADR-003](../../adr/003-storage-and-journals.md) Storage & Journals | Investigation/Personalization SQLite 物理拆分、迁移、备份 | M0/M3 |
| [ADR-004](../../adr/004-sidecar-lifecycle.md) Sidecar lifecycle | process、RPC、cancel、restart、capability negotiation | M1 |
| [ADR-005](../../adr/005-authenticated-source-transport.md) Authenticated source transport | opaque IDs、PDF Range、assets、cache headers | M1 |
| [ADR-006](../../adr/006-selection-submission.md) Selection submission | stable composer reference + staged nonce + pre-step claim/request commit | M2 |
| [ADR-007](../../adr/007-library-source-admission.md) Library source admission | opaque candidate、nofollow import、job/dedupe/revision | M2 |
| [ADR-008](../../adr/008-reader-focus-and-dual-cursors.md) Reader focus & dual cursors | Host resolve、follow、no wrong highlight | M2 |
| [ADR-009](../../adr/009-answer-manifest-admission.md) AnswerManifest admission | same-turn marker、Evidence、gap、action | M2 |
| [ADR-010](../../adr/010-source-scope-overview-and-patch.md) SourceScope overview/patch | exact layers、CAS delta、DSH runtime context | M2 |
| [ADR-017](../../adr/017-controlled-pdf-reader-and-compare.md) Controlled PDF Reader + Compare | page RPC、bitmap/text rail、独立A/B cursor、no fake bbox | M2 |
| [ADR-011](../../adr/011-record-recall-review-boundaries.md) Record/Recall/Review surface | typed record、lead-only recall、actual Review分离 | M3/M4 |
| [ADR-012](../../adr/012-research-tree-overlay.md) Tree Overlay | exact Locator projector、rebuild/retract、immutable canonical tree、budgets | M3 |
| [ADR-013](../../adr/013-research-continuity.md) Research continuity | source inclusion、stale impact、reverify、cross-workspace policy | M5 |
| ADR-014 Personalization | profile identity、promotion、effects、session controls | K0/M6 |
| ADR-015 Privacy/deletion | local-only、export、cascade/orphan/redact、backup/WAL | M3/M6 |
| ADR-016 DSH compatibility | compile/runtime targets、slot/API probes、upgrade policy | 每次 release |

## 15. 测试与评测总计划

### 15.1 测试层

1. Schema invalid/valid fixtures；
2. TS/Python parity 和 protocol negotiation；
3. pure lifecycle/state-machine/property tests；
4. SQLite migration/crash/locking/idempotency；
5. sidecar RPC/cancel/restart/concurrency；
6. Host tool event/projection/cold replay；
7. authenticated Client RPC/Fetch/browser E2E；
8. real PDF/document-type corpus；
9. opt-in Azure Luna Agent E2E；
10. longitudinal Research Memory/Personalization scenarios。

### 15.2 Evidence 指标

- locator resolution/re-anchor；
- block recall@5/@10；
- citation completeness/precision；
- claim coverage/atomicity；
- counterevidence and contradiction recall；
- unknown/not-found/false accuracy；
- source revision freshness；
- visual/table/OCR correctness。

### 15.3 Research Memory 指标

- prior-work lead precision/recall；
- stale/superseded/missing-source detection；
- open-question closure；
- cross-scope leakage；
- re-resolution success；
- tool/read steps saved；
- circular self-support success rate，目标为零。

### 15.4 Personalization 指标

- candidate precision、abstention、update/forget；
- decision adherence、why-used comprehension；
- preference choice consistency 和 drift；
- time-to-evidence、steering、review burden；
- harmful use、poisoning、sycophancy、filter bubble；
- on/off factual and citation non-regression。

### 15.5 固定兼容矩阵

- Downstream DocAtlas：Python 3.10、3.11、3.12.12、3.13；
- Product sidecar：固定 CPython 3.12.12 + uv locked；
- DSH compile baseline 与 runtime target 分别验证；
- Node/pnpm 精确版本；
- browser：至少 Chromium，随后 Firefox/WebKit；
- Linux first，平台特定行为显式记录。

## 16. 安全、隐私和治理 Gates

- 文档、Markdown、OCR、Note、Memory、Web 和 tool output 全是不可信 data；
- document/tool/assistant 内容不可直接生成 active Personal Memory；
- secret detector 在 personal observation 写入前执行；
- source/provider 每次越过本地边界都展示发送字段和 retention；
- local-only 是默认，不宣称 SQLite 已加密；
- profile/workspace/source ACL 在 relevance ranking 前执行；
- delete 区分 memory、excerpt、source session、artifact 和 backup/WAL；
- cross-source recall 默认 suggest，扩大 scope 要显式记录；
- high-impact memory 写入、publish、external side effect 使用 approval/human review；
- malicious PDF 无法创建 preference、policy 或 tool permission；
- model-generated Note/Claim/ReviewResult 始终标 actor/type/status；
- derived source 不能支持其祖先 Claim；
- audit log 不保存 bearer token、API key 或无界原文。

## 17. Source、升级和发布维护

### 17.1 Source workflow

```bash
bash scripts/sync_sources.sh
bash scripts/verify_sources.sh
bash scripts/check_source_updates.sh
```

每次 pin 更新：审查 commit diff → 更新 `sources.lock.json` → sync/verify → 跑 source probes → 跑 contract/
browser/live matrix → 更新 compatibility 记录。`.sources` 永远不是产品 build dependency。

### 17.2 Downstream DocAtlas

- `DocAtlas-Harness/` 保持官方 Microsoft `origin` 和明确 downstream branch；
- 不使用 symlink 与 sibling 原始 checkout 同步写入；
- 每个实验记录 upstream base、变更、tests、迁移目标和废弃条件；
- rebase 前先对比 upstream Note/Review/Read/Session/Tree 变化；
- 产品行为迁入 sidecar/contracts 后，实验补丁可以缩减为上游贡献或兼容 probe。

### 17.3 Release gates

- `bash scripts/check.sh`；
- locked install/build/package/publint；
- schema/migration compatibility；
- DSH packed-plugin mount；
- browser/auth/cold replay；
- security and secret scan；
- milestone eval；
- release notes 含 data migration、rollback 和 known limitations。

回滚不能删除新版本 domain data；需要 forward-compatible reader 或 export/restore procedure。

## 18. 目标目录演进

只在对应 milestone 开始时创建目录，避免空 scaffold 被误认为产品能力：

```text
DocAtlas-dsh/
├─ docs/
│  ├─ implementation-plan.md
│  ├─ adr/
│  └─ runbooks/
├─ contracts/
│  ├─ protocol/
│  ├─ source-evidence/
│  ├─ investigation/
│  ├─ claim-review-artifact/
│  └─ personalization/
├─ packages/contracts/
├─ plugins/docatlas-dsh/
│  ├─ src/host/
│  │  ├─ sidecar/ tools/ transport/ projection/
│  │  ├─ investigation/ review/ memory/ personalization/
│  │  └─ storage/
│  ├─ src/client/
│  │  ├─ views/ reader/ evidence/ notebook/ claims/ review/
│  │  └─ personalization/ styles/
│  └─ test/{contract,host,client,e2e}/
├─ python/docatlas-sidecar/
│  ├─ src/.../{protocol,providers,ingest,index,read,locator}/
│  └─ tests/{unit,contract,integration}/
├─ evals/
│  ├─ progressive-read/
│  ├─ locators-and-navigation/
│  ├─ web-interactions/
│  ├─ claims-and-citations/
│  ├─ research-continuity/
│  ├─ personalization/
│  └─ longitudinal/
├─ compat/
├─ research/
└─ DocAtlas-Harness/
```

## 19. 明确延后

- Audio/Video Overview 和完整多媒体 Studio；
- 自由知识图谱画布；
- graph database；
- 默认 embedding 和 cross-encoder；
- fine-tuning/LoRA/online RL；
- always-on hidden background agent；
- 自动团队 Memory 与跨组织同步；
- 百万文档虚拟 Tree；
- 自动修改已发布 Artifact；
- 任意 Note/Artifact 自动升级为 factual source；
- 一开始支持所有云 provider；
- 未经评测的自动 source exclusion 或 personalized verification。

只有 exact/FTS baseline、真实查询和规模数据证明不足时，才引入 embedding/graph；只有 outcome 定义和
纵向安全评测成熟后，才考虑更强的策略学习。

## 20. 立即执行队列

以下顺序是当前完整计划的下一组可执行工作：

1. 评审并确认本 Master Plan 的已确认/暂定边界；
2. 为 multi-doc Tree annotation 加 containment：默认关闭或要求 doc identity；
3. 给 factual Note 无 evidence、invalid page、101 notes、two Notes/turn 补回归；
4. 整理并固化 downstream progressive-read patch 与测试 artifact；
5. 起草 ADR-001 Runtime Ownership；
6. 起草 ADR-002 Document Identity & Locator；
7. 冻结第一批 M0 schemas：ProtocolError、DocumentRevision、Representation、SourceScope、Locator、Evidence；
8. 生成 TS/Python parity fixtures；
9. 设计 sidecar lifecycle 与 `ingest/search/read/resolve` RPC；
10. 将 persistent Block Map + FTS5 作为 M1 第一个 Python slice；
11. 注册 DSH `docatlas_search/read`，完成 Luna local-PDF E2E；
12. 验证 authenticated PDF Range 和 first Client View；
13. 做 selection → EvidenceAtom contract spike；
14. 再进入 Investigation Journal、record/recall、Tree Overlay；
15. Claim/Review/Publish 闭环稳定后，激活 Research Continuity 与 Personalization 的高影响部分。

## 21. 当前暂定项与需要讨论的决定

已由实现与 ADR 固化：

1. Host domain core 使用 TypeScript；document providers/index 保持 Python。
2. Investigation 与 Personalization 使用物理独立 SQLite；Continuity/M4 只附着同一 Workspace Investigation DB。
3. Agent-facing surface 保持 `record/recall`；真正 Review/Publish 使用 authenticated、可观察的多步 Host RPC，
   当前不增加第二 Agent Loop 或万能 memory/review tool。
4. Research continuity 首版只支持同 workspace、suggest-only。
5. Personalization v0 使用 deterministic rules + FTS5，不用 embedding。
6. PreferenceProbe 自动触发每 investigation 最多一次，阈值需 UX 数据校准。
7. Fact Trace non-regression 已通过；source ranking/reading plan 仍保持关闭，待真实纵向指标后另签作用面 ADR。

仍需产品决定：

- 首发默认单机单 active profile；底层支持多个物理隔离 profile，但跨 profile 切换/共享仍不开放；
- ResearchPolicy 与 ProjectDecision 的团队继承、远端同步和 enforcement 边界；
- 哪些 PreferenceProbe axis 首发；
- M3 是否把 Note 保留为产品主名，还是统一称 Annotation/Research Note；
- 团队/云部署之前的本地数据库加密和 backup 策略；
- 哪些 upstream DocAtlas 改动适合反向贡献，哪些仅留在 plugin/sidecar。

## 22. Definition of Done

整个首发路线完成时必须满足：

1. 用户可在 DSH Web 中选择文档、看到原文、与 Agent 同步但不被抢 cursor；
2. Agent 使用一个渐进 Read tool 获取 bounded blocks/visual，不向模型倾倒整页集合；
3. 每个 material claim 可点击回固定 revision 的精确 evidence；
4. 多文档、版本变化、冲突、unknown 和 derived claim 可被正确表达；
5. 用户可直接 Note、提问、形成 Claim、Challenge、Review 和 Publish；
6. Research Memory 能把旧工作作为 lead 带回，并在使用前重新核验；
7. Personalization 能减少重复 instruction，并显示 why-used、scope、edit/forget；
8. Preference Probe 只改变呈现变量，不改变事实 backbone；
9. personalization/continuity on/off 不导致 factual、citation 或 conflict regression；
10. DSH 是唯一 Agent Loop，所有模型步骤、approval、cancel 和结果可观察；
11. browser/auth/path/secret/provider/data-retention gates 通过；
12. contracts、migration、cold replay、version matrix、real-PDF 和 longitudinal eval 可重复；
13. source upgrade 和 rollback 有记录、脚本与 compatibility evidence；
14. 产品明确区分 Sources、Related prior work、Why personalized 和 Agent Activity。

## 23. 研究结论追踪矩阵

| 输入文档 | 已吸收的核心结论 | 主计划位置 |
|---|---|---|
| `01-dsh-architecture` | DSH 唯一 Loop、静态 Host/Client plugin、authenticated Connection、升级边界 | §§3、5、7、17 |
| `02-pageindex-sdk` | Provider capability、分页/限额、locator 超越 page tag、Lens 不改 canonical tree | §§6、8、15 |
| `03-personalization-memory` | governed lifecycle、scope/time/provenance、why-used、non-interference | §12、§16 |
| `04-document-experience` | 三栏原文优先、dual cursor、citation focus、selection、responsive | §9、M2 |
| `05-roadmap` | identity → read → desk → claim → memory → personalization 的门控顺序 | §13 |
| `06-commercial-systems` | source scope、interactive artifacts、active reading、notes lineage、human review | §§1、9–11 |
| `07-fact-trace-agent-interaction` | Evidence/Claim/Relation/Derivation、五级 gates、Agent checkpoints | §§4、6.6、7.4、M4 |
| `08-product-route-v2` | Evidence-native Personal Research Agent、七个产品面、Explore/Verify/Publish | §§1、9、9.5 |
| `09-upstream-docatlas-implementation` | Search/Read 可演化；旧 Loop/Note/Review/session/tree 不能直接成为产品真相 | §§2、10、X0 |
| `10-docatlas-native-personalization` | Personalization 属于 DocAtlas domain、DSH 执行模型、三域隔离 | §§3–5、12 |
| `11-personalization-implementation-research` | Observation→Candidate→Decision→Use/Outcome、FTS baseline、纵向评测 | §12、§15 |
| `12-progressive-read-spike` | 单 Read 五 mode、bounded blocks、candidate 不是 evidence | §8、M1 |
| `13-progressive-read-stress-results` | 体积收益、query-time latency、sequential amplification、OCR/text quality | §§2.4、8.2、15 |
| `14-adaptive-interface-research-continuity` | Preference Probe、Research Memory、recall-to-reverify、正交控制 | §§11–12、M5–M6 |
| `15-note-review-memory-design-space` | Note/Review/Memory 正交、真正 Review、Tree Projection、record/recall 备选 | §§3.3、7、10、M3–M4 |
| `16-web-ui-interaction-design` | 逐 claim citation、exact source focus、多文档 IA、selection、业务模板、DSH UI seams | §9、M2、§15–16 |

专题研究仍是设计证据和细节来源；本矩阵用于确认每个讨论结论已经进入某个可执行阶段或显式未决项。

