> Historical DSH snapshot, archived on 2026-09-08. Not the current execution authority.
> See [current plan](../../implementation-plan.md) and [migration inventory](../../migration/dsh-to-core.md).
> Body preserved; relative Markdown links rebased for this archive directory.

# DocAtlas × DSH 执行任务板

> 状态：Active
> 建立日期：2026-08-30
> 执行依据：[完整实施主计划](implementation-plan-v0.2.md)
> 更新规则：只记录已经开始、可验证或明确排队的工作；研究备选不伪装成实施进度。

## 状态说明

| 状态 | 含义 |
|---|---|
| `done` | 代码/文档和对应验证均完成 |
| `in-progress` | 当前唯一正在实施的工作包 |
| `queued` | 依赖满足后可执行 |
| `blocked` | 有明确外部依赖或待用户/ADR 决定 |
| `deferred` | 明确不属于当前 release |

## 当前阶段

```text
F0 Foundation                    done
X0 Downstream hardening          done
M0 Identity & contracts          done
M1 DSH Read vertical slice       done
M2 Evidence Desk                 done
M3 Investigation / Tree Overlay  done
M4 Claim / Review / Publish      done
M5 Research Continuity           done
M6 Personalization               done
M7 Extensions                    deferred
```

## X0：Downstream hardening

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| X0-001 | `done` | Progressive Read 五 mode 与压力测试 | 180 tests × Python 3.10–3.13；435-call stress 已记录 |
| X0-002 | `done` | TUI progressive summaries 与 picker 修复 | 下游相关 tests 通过 |
| X0-003 | `done` | 多文档 legacy Tree annotation fail closed | B/p.2 不再写入 A/p.2；单文档行为不回归 |
| X0-004 | `done` | 同一 Agent turn 多条成功 Note 均投影 | 两条 Note 的允许 side effects 各自生效 |
| X0-005 | `done` | PostNote 只由成功 Note 触发 | 失败 Note 不重复处理旧 entry；refresh 失败时不处理 stale state |
| X0-006 | `done` | Note/Review/Tree 已复现边界分流 | multi-doc/hook tests 已完成；locator 进入 M0；recall pagination/evidence-only 进入 M3 |
| X0-007 | `done` | 固化 downstream patch 与 upstream diff | `DocAtlas-Harness/DOWNSTREAM_PATCHES.md`可重放；upstream差异与迁移/废弃边界已审计 |

本阶段只做 containment 和可复现性，不把 legacy `Page N`、NoteStore 或 Review aux LLM 升级为正式
Research Memory。正式语义在 M0/M3 contracts 中解决。

## M0：下一队列

| ID | 状态 | 工作 | 依赖 |
|---|---|---|---|
| M0-001 | `done` | ADR-001 Runtime Ownership | Accepted；DSH/Host/Python/Client 边界冻结 |
| M0-002 | `done` | ADR-002 Document Identity & Locator | Accepted；五层 identity 与 selector/resolution states 冻结 |
| M0-003 | `done` | ProtocolError/PageInfo schemas | Draft 2020-12 + strict Ajv/python validation |
| M0-004 | `done` | DocumentRevision/Representation schemas | canonical fixture + derived lineage checks |
| M0-005 | `done` | SourceScope/Locator/EvidenceAtom schemas | shape + semantic identity checks |
| M0-006 | `done` | TS/Python binding parity fixtures | shared canonical slice；matching semantic issue codes |
| M0-007 | `done` | multi-doc/revision/stale selector contract tests | same-page A/B、stale、ambiguous、mismatch fixtures |
| M0-008 | `done` | ADR-003 Storage & Journals | Investigation/Profile SQLite 分离；Session/cache/blob 边界冻结 |
| M0-009 | `done` | Runtime contract parser/registry | generated strict Ajv Host parser + packaged Python jsonschema registry |
| M0-010 | `done` | Legacy page-note import policy contract | importer 只能产 unresolved/unverified `LegacyEvidenceLead` |

M0 exit gate 已完成：identity/locator contracts、三份 ADR、双语言 production parsers、same-page/stale/
ambiguous fixtures 和 legacy fail-closed importer 均通过完整 workspace gate。

## M1：DSH Read vertical slice

| ID | 状态 | 工作 | 退出条件 |
|---|---|---|---|
| M1-001 | `done` | ADR-004 Sidecar Lifecycle | process/negotiation/cancel/restart/backpressure 边界冻结 |
| M1-002 | `done` | capabilities/ingest/search/read/resolve RPC contracts | schemas、typed bindings、semantic/errors、shared parity fixtures 全部通过 |
| M1-003 | `done` | Host child-process supervisor | negotiate、双lane queue、AbortSignal、bounded recovery、Cordis/package lifecycle |
| M1-004 | `done` | Python ingest + persistent Block Map/FTS | revision-bound index、atomic publish、text quality、persistent idempotency |
| M1-005 | `done` | Search/text Read/resolve sidecar handlers | FTS、四种文本mode、bounded cursor、locator resolution；visual留给M1-007 |
| M1-006 | `done` | DSH `docatlas_search/read` tools | standard events/meta、cold replay、structured errors、scope fail-closed |
| M1-007 | `done` | authenticated PDF/visual asset Fetch | opaque IDs、Range/ETag、visual mode、permission/size limits |
| M1-008 | `done` | Luna local-PDF E2E | search→locate→blocks→answer，唯一 DSH Loop |

M1 exit gate 已完成：真实PDF可由唯一DSH Agent Loop完成Search→locate→blocks→answer；工具状态可cold
replay；authenticated original/page assets有scope-bound Range transport；Python不包含Agent或模型凭据。

## M2：Evidence Desk 与 selection → Evidence

| ID | 状态 | 工作 | 退出条件 |
|---|---|---|---|
| M2-001 | `done` | ADR-006 Selection submission | atomic context、nonce/consume、composer tray与失败语义冻结 |
| M2-002 | `done` | Host/Client Evidence Desk RPC + Source Scope registry | typed auth RPC、per-session/investigation scope、cold/listing |
| M2-003 | `done` | Library + source ingest/status | PDF/Markdown、revision/status、single-reader与bounded catalog |
| M2-004 | `done` | three-pane reader shell | DSH slots、responsive layout、PDF/Markdown/figure capability state |
| M2-005 | `done` | dual cursors + citation focus | user/Agent cursor隔离、stale/ambiguous fallback、no wrong highlight |
| M2-006 | `done` | AnswerManifest/Segment/CitationPresentation | material factual span → Claim/Evidence |
| M2-007 | `done` | Source Scope Drawer | eligible/included/used/cited/excluded/candidate分层 |
| M2-008 | `done` | atomic selection + context tray | text/table/figure/multi-range、message绑定、consume/retry |
| M2-009 | `done` | selection actions | EvidenceAtom/Note/OpenQuestion/Claim proposal，不隐式升级事实 |
| M2-010 | `done` | Compare + accessibility/security/browser eval | controlled Reader、10类矩阵、真实PDF、breakpoints、keyboard、wrong-doc/page gate |

## M3：Investigation capture/recall 与 Tree Overlay

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| M3-001 | `done` | ADR-011 Record/Recall/Review boundary | record写typed event；recall只返回lead；Review保持独立 |
| M3-002 | `done` | Investigation schema v5 + typed journal + backup | call-bound record、unified aggregate lifecycle、0600 verified backup/restore |
| M3-003 | `done` | cross-Session Research Recall FTS | Workspace隔离、source-state、budgets/cursor、restart rebuild |
| M3-004 | `done` | `docatlas_record` / `docatlas_recall` | 单DSH Loop；无第二模型；不产生Evidence/accepted fact/Decision/Review |
| M3-005 | `done` | lifecycle + recovery commands | Agent/selection统一CAS lifecycle；backup-first v4迁移；no-overwrite restore验证 |
| M3-006 | `done` | Working/Research Tree Overlay | canonical tree immutable、startup rebuild、delete retract、exact Locator/page/source |
| M3-007 | `done` | legacy adapters + minimal Notebook | LegacyEvidenceLead fail-closed adapter；bounded working/workspace Notebook RPC；无视觉重构 |

## M4：Claim Ledger、Review 与 Publish

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| M4-001 | `done` | Claim/EvidenceRelation/Derivation contracts | immutable ClaimVersion、正交状态、Memory不可作Evidence、lineage checks |
| M4-002 | `done` | Review/Artifact contracts + ADR-019 | G0–G4 deterministic gates、Brief/Matrix exact ClaimUse、human不能覆盖fail |
| M4-003 | `done` | isolated append-only M4 store | Claim CAS、support/refute、review、sign-off、publish、tamper/idempotency tests |
| M4-004 | `done` | authenticated M4 RPC + Investigation integration | exact Workspace/Investigation/SourceScope gates、canonical Evidence resolver |
| M4-005 | `done` | Claim Ledger/Review/Publish necessary UI + E2E | one claim→conflict→human decision→published brief |

## M5：Research Continuity

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| M5-001 | `done` | ADR-013 + continuity/revision-impact contracts | four states、fresh Evidence、active scope、stable cursor、strict identity |
| M5-002 | `done` | isolated ContinuityService | lead lookup、scope/evidence admission、idempotent link、revision impact pagination |
| M5-003 | `done` | Investigation journal/runtime integration | append-only ContinuityLink、Continue OpenQuestion、revision impact、authenticated RPC |
| M5-004 | `done` | longitudinal safety scenarios | financial/contract/research/audit + cross-scope leakage eval |

## M6：Governed Personalization

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| M6-001 | `done` | ADR-014/015 + core/command contracts | dual switches、scope/consent、decision invariants、forget/export truth |
| M6-002 | `done` | separate Profile SQLite ledger | physical domain split、candidate/version/use/probe lifecycle、CAS/tamper |
| M6-003 | `done` | authenticated controls + decision compiler | pause/edit/forget/export、why-used、bounded effects |
| M6-004 | `done` | necessary UI + Fact Trace non-regression | on/off support/citation/conflict identical；longitudinal safety tests |

## M1–M6 集成 Gate

| Gate | 必须完成后才能进入 |
|---|---|
| M1 | M0 identity/locator contracts、sidecar lifecycle ADR |
| M2 | M1 Search/Read E2E、authenticated PDF Range、focus contract |
| M3 | selection→Evidence、Investigation Journal/Tree Overlay ADR |
| M4 | Evidence/Claim contracts、Review surface ADR |
| M5 | Claim/Review lifecycle、ResearchRecallLead/reverify contracts |
| M6 | Fact Trace non-regression、Personalization K0–K3、longitudinal fixtures |

## 验证记录

### 2026-08-30 · X0 PostNote containment

- multi-document `doc_map` 大于一时，legacy page-only annotation fail closed；
- single-document projection 使用当前 question，不再写笼统 `the previous search`；
- 同一成功 turn 的多条 Note 各自按 `side_effect_policy` 投影；
- failed Note 不进入 post-success hooks；session refresh 失败时不 archive/annotate stale state；
- 新增/更新 targeted suite：17 passed on Python 3.10、3.11、3.12.12、3.13；
- 默认 Python 3.12.12 full suite：185 passed；
- Ruff 0.16.5 check/format 和 mypy 2.3.1：通过。

版本矩阵必须串行运行，并带 `--extra dev`；不同 `uv run --python` 共享项目 `.venv`，禁止并行切换解释器。

### 2026-08-30 · M0 identity/contracts

- ADR-001 Runtime Ownership、ADR-002 Identity/Locator、ADR-003 Storage/Journals：Accepted；
- 9 个 catalog schemas + 2 组共享 M0 fixtures；
- TypeScript typed/semantic bindings、strict Ajv production parser；
- Python typed/semantic bindings、packaged jsonschema production parser；
- deterministic generator + stale-generated-code check；
- JS workspace：3 files / 14 tests；Python sidecar：25 tests；完整 `scripts/check.sh` 通过；
- wheel smoke 确认 contracts、generated schema bundle、runtime validator 和 `jsonschema==4.26.0` 均已打包。

### 2026-08-30 · M1 capability negotiation

- sidecar envelope protocol 从 1.0.0 升级到 1.1.0；document RPC family 为 1.0.0；
- 新增 strict `sidecar-capabilities` schema 和 runtime parsers；
- Python 实现 `capabilities`，只广告实际实现的 `health/capabilities`；
- concurrency/request/document/text/image limits 与 runtime build identity 可协商；
- TypeScript 与 Python negotiation tests、真实 JSONL 双请求 cross-language check 通过；
- ingest/search/read/resolve 未实现且未被 capabilities 广告。
- `sidecar-document-rpc.v1` schema family 已加入并通过 strict Ajv/jsonschema 编译；typed bindings、共享
  request/result fixtures 和 method handlers 仍在 M1-002 中。
- TypeScript document RPC discriminated unions 与 semantic validators 已完成；Python 对等 bindings 和共享
  M1 fixtures 已完成；document handlers 尚未实现，因此继续保持未广告状态。

### 2026-08-30 · M1 document RPC contract gate

- `sidecar-document-rpc.v1` 定义 ingest/search/read/resolve request/result；
- TypeScript/Python discriminated bindings 和 matching semantic issue codes；
- 共享 M1 fixture 覆盖 ingest、search、五种 Read、block result、resolved locator；
- source binding 拒绝 absolute/drive/backslash/parent/empty/dot path segments；
- JSON-RPC failure 强制携带 canonical ProtocolError data；
- JS workspace：4 files / 21 tests；Python sidecar：32 tests；完整 `scripts/check.sh` 通过；
- capability roster 仍只含 `health/capabilities`，未实现方法不可调用。

### 2026-08-30 · M1 supervisor core

- 使用 DSH `ctx.subprocess` seam，不直接建立第二套 Node process ownership；
- supervisor 状态机、health/capabilities negotiation、typed request correlation 和 line bounds；
- out-of-order/multi-line responses、AbortSignal tombstones、malformed/unknown ID generation failure；
- bounded stderr tail、EOF-first graceful disposal、TERM→KILL 交给 DSH process-tree provider；
- restart 只在旧 generation quiescent 后启动；
- capability-based ingest/read双lane queue、总deadline、queue bound与queued abort；
- bounded exponential restart、retry exhaustion、stable-period reset与backoff disposal；
- standalone locked Python runtime生成/漂移检查，`uv --isolated --no-dev --locked`不写npm包目录；
- `ctx.docatlas` Cordis service、`inject=['subprocess']`与fiber-owned teardown；
- supervisor 17 tests（含两项真实Python进程/Cordis集成）；
- JS workspace 5 files / 38 tests、Python 32 tests，完整 `scripts/check.sh` 和npm dry-run内容断言通过。

### 2026-08-30 · M1 persistent document index

- BSD许可 `pypdf==6.15.0` PDF embedded-text baseline + UTF-8 Markdown/plain-text provider；
- source root containment、symlink escape拒绝、抽取前后size/SHA-256验证和PDF magic/page-count校验；
- revision/representation-scoped稳定Block IDs、NFC/LF normalization与empty/sparse/garbled/usable质量；
- SQLite pages/blocks/metadata + FTS5，FULL synchronous、foreign keys、integrity/hash/row-count checks；
- immutable generations + fsync + atomic `current.json` pointer，crash/cancel不发布partial index；
- persistent idempotency replay/conflict、force rebuild、bounded generation retention和corruption fail closed；
- partial page representation正确记录indexed page count，总页数独立保留；
- 4 block tests + 7 ingest tests，覆盖真实生成PDF、FTS、restart replay、TOCTOU边界、同页多文档；
- packaged runtime同步为11 files并独立锁定pypdf；JS 38/Python 43 tests及npm内容断言通过。

### 2026-08-30 · M1 text document handlers

- configuration-gated capabilities：未配置roots/cache时仅health/capabilities；配置后广告
  ingest/search/read/resolve、四种文本Read modes和pdf/markdown providers；
- Search：approved source identities、plain-token FTS5、stable ranking、item/char bounds和query-bound cursor；
- Read：locate/blocks/expand/sequential、块内character cursor、无隐藏整页输出；
- 每个text item带revision/representation/content-hash绑定的block + position + quote Locator；
- Resolve：resolved/stale/missing/page-only/ambiguous、unique quote re-anchor、bounded/optional candidates；
- CLI与Host只通过显式绝对argv配置rootId/cache，拒绝不成对、相对路径和非法root IDs；
- structured domain errors映射canonical ProtocolError；stdio诚实报告serial read concurrency 1；
- visual/figure未实现且未广告，随M1-007 authenticated asset route交付；
- Python新增8 service + 3 protocol-chain tests；Node新增真实
  `Supervisor → packaged Python → ingest → search → read → resolve` E2E；
- packaged runtime 12 files；JS 5 files / 40 tests、Python 54 tests、完整gate及npm内容断言通过。

### 2026-08-30 · M1 DSH tools and cold projection

- 仅注册`docatlas_search`与`docatlas_read`；未获document capabilities时两者均不注册；
- model schemas不暴露source roots、relative paths或representation IDs，Host从冻结SourceScopeVersion绑定；
- 同document多revision要求显式revisionId，任何scope外document fail closed；
- DSH `defineTool` canonical JSON boundary、AbortSignal转发、concurrency-safe只读声明与bounded model content；
- sidecar/contract错误映射稳定HarnessError code，经真实ToolRuntime产出structured failure info；
- 新增`docatlas-tool-meta.v1` schema：最多50 candidate IDs/Locators、64 KiB aggregate cap；
- 只使用标准`tool/call`、`tool/result.meta`和`turn/end`，未声明自定义Session Event；
- `docatlas.tools` projection最多32 pending，仅保留last Search/Read与最近document IDs；
- 实际pinned SessionProjectionRegistry cold restore/checkpoint通过，browser/client entry共享projection类型；
- 真实Cordis ToolRuntime → Supervisor → packaged Python Search/Read → meta E2E，plugin dispose移除工具；
- JS 8 files / 52 tests、Python 55 tests，完整build/publint/compat/package gate通过。

### 2026-08-30 · M1 authenticated source/visual transport

- 签署ADR-005：DSH authenticated exact Fetch、逐请求scope auth、single Range、strong ETag与mutable auth cache policy；
- 新增无path的`asset-descriptor.v1`跨语言contract与semantic pixel/byte/hash检查；
- ingest在index publish前原子复制verified original bytes到immutable asset entry；源文件之后突变不影响服务；
- pypdfium2 5.13.0渲染PDF page，40M aggregate pixels、32768单边、32MiB PNG限制；figure未索引显式unavailable；
- stdlib streaming PNG encoder，无Pillow/Numpy依赖；render-key pointer与asset目录均atomic/fsync；
- Host只由`sha256(assetId)`解析固定descriptor/content文件，拒绝symlink并在每次授权fetch重验同一handle的hash；
- `/api/docatlas.asset`支持GET/HEAD、closed/open/suffix Range、416、If-Range、If-None-Match和nosniff；
- 授权敏感缓存使用`private, no-cache, must-revalidate`，scope撤权不会被`immutable`浏览器缓存绕过；
- 运行目标0.1.2-alpha.1的cookie-authenticated exact Fetch存在时才挂route；公开rc.2 baseline缺seam时fail closed；
- Read visual canonical value/meta只含opaque asset identity/dimensions/Locator，不含base64或重复page text；
- browser-safe `docAtlasAssetUrl()`只生成固定same-origin route，不接收path；
- packaged runtime加入pypdfium2独立uv lock与第三方notices；真实PDF Range与PDFium PNG跨语言E2E通过；
- 修复Python gate未加载sidecar strict mypy config的问题；当前JS 11 files / 78 tests、Python 61 tests全绿。

### 2026-08-30 · M1 Luna local-PDF single-Loop exit

- 普通CI使用真实AgentLoop + 真实生成PDF + packaged sidecar + deterministic adapter；
- 第三个模型step从上一个标准locate tool result动态解析实际blockId，不由测试预注入；
- Session严格为1 turn / 4 steps / 3 tool calls：Search → Read locate → Read blocks；
- 三项tool/result均成功且携带bounded meta；无`docatlas/*`自定义Session Event；
- live projection与从完整event log cold restore的`docatlas.tools`状态完全相等；
- 真实Azure GPT-5.6 Luna通过同一断言，回答`USD 15.2 million / physical PDF page 2`；
- 发现并修复provider对optional cursor填空串导致合法Search重试：仅在模型边界归一neutral optional值；
- Azure launcher只向测试子进程注入短期Entra bearer，0600 evidence与tracked workspace token扫描通过；
- 最新证据：`.cache/azure-luna-docatlas-e2e.json`，1 turn、4 steps、3 standard tool calls/results；
- test-only adapter依赖的`@google/genai`/`protobufjs`安装脚本经审计显式禁用。

### 2026-08-30 · M2 atomic selection contract gate

- 签署ADR-006：staged nonce + stable context ID + public reference chip + pre-step claim/request commit；
- nonce只授权cancel并只存在Host/Client transient state；composer/Session只出现非bearer stable context ID；
- DSH发送失败保留draft/context；pre-step整组claim，downstream reject/throw释放，user/message append后commit；
- SelectionContext绑定session/workspace/investigation/scope、document/revision/representation/hash和1–16 Locators；
- selected content每项bounded，aggregate canonical context 64KiB；multi-range与kind/selector有semantic gate；
- selection RPC冻结stage/prepare/status/cancel、192-bit nonce格式、expiry和bounded previews；
- 共享M2 fixture由strict Ajv与Python jsonschema共同验证；nonce/path不能进入durable context；
- compat probe锁定`conversation.input.dock`、reference codec、pre-step和standard user/message append seams。

### 2026-08-30 · M2 per-session SourceScope + authenticated RPC

- M1全局scope替换为Session-keyed registry；Search/Read从`exec.agent.id`解析，agent-less调用fail closed；
- asset URL强制显式opaque `sessionId`，无session为400，wrong/unbound session与missing asset同为404；
- `source-scope-rpc.v1`覆盖get/commit/bind/unbind、CAS、idempotency与exact representation hash；
- 独立bind让第二Session加入既有Investigation，不伪造新ScopeVersion；
- operator-owned absolute `domainRoot`；per-workspace SQLite + session binding projection；WAL/FULL/foreign keys；
- append journal/current projection同事务；version chain/payload hash/quick-check/unknown schema均fail closed；
- restart恢复、commit/bind/unbind replay、same-key different-payload冲突、0600/0700权限通过；
- authenticated `/docatlas` channel返回版本化browser envelope；Client helper区分transport/domain/invalid response；
- browser scope commit只接受trusted Host Library预注册的workspace-eligible exact source；不以ingest自动授权；
- live Session gate：Agent运行中拒绝scope mutation，缺Agent registry、unknown Session均fail closed；
- full gate：18 JS files / 101 passed + 1 explicit Azure conditional skip；Python 63 passed。

### 2026-08-30 · M2 Library admission + ingest jobs

- `library-document.v1`与`library-rpc.v1`冻结candidate/import job/list/get边界；browser不含Host path；
- ADR-007冻结source-root discover：固定Connection没有authenticated upload POST，不以base64/path冒充上传；
- bounded recursive nofollow discover；opaque candidate/cursor绑定Session+workspace并在5分钟过期；
- import用同一open handle做stat→SHA-256→stat，sidecar再次校验root/length/media/hash；
- input-only `IngestRevision`允许PDF页数未知；sidecar解析后产出canonical durable pageCount；
- per-workspace document/revision/source binding/job projections与append journal落同一SQLite；
- exact bytes跨binding复用document；同binding新bytes生成previous-linked revision；catalog上限10,000；
- queued/running job重启后成为显式retryable failure；idempotency冲突与unknown schema零写入fail closed；
- Library是workspace eligibility的browser入口；进入Library不改变Session SourceScope；
- authenticated endpoints：discover/import/job/list/get；Client helper保持typed resultType fence；
- Session header Library drawer按Host probe出现，跟随DSH locale，中英文、ARIA、Escape与poll cancellation齐备；
- real Python E2E从同一root导入Markdown与PDF，job→record→eligible→restart通过；
- full gate：22 JS files / 115 passed + 1 Azure conditional skip；Python 64 passed。

### 2026-08-31 · M2 three-pane reader shell

- Evidence Desk 通过DSH原生`conversation.view`注册，不迁移或复制TUI/Agent Loop；
- 三栏分别承载Library/结构入口、原始文档reader、来源版本/Investigation占位，窄屏共用同一state model折叠；
- Library list/get按Session+Workspace鉴权；选中文档绑定current revision，不接收或显示Host path；
- PDF使用authenticated original asset预检和内嵌原文面；Markdown复用DSH安全renderer，纯文本按literal显示；
- 浏览器文本读取同时检查media、UTF-8、声明长度与实际stream，4 MiB以上拒绝整份渲染并引导progressive Read；
- figure crop和结构化outline没有真实provider时显式unavailable，不用模型生成内容冒充原文能力；
- Library阅读授权与Agent SourceScope继续分离；Host只允许正确Session/Workspace中current revision的original asset；
- 同时兼容公开DSH rc.2的旧View/Markdown props与0.1.2+的一次性view focus handoff；
- component test覆盖focus acknowledgement，asset tests覆盖wrong Session/stale revision/hash mismatch；
- full gate：23 JS files / 122 passed + 1 Azure conditional skip；Python 64 passed；isolated DSH rc.2 mount通过；
- client bundle：56.53 kB / 13.25 kB gzip；primitive保持Host peer external，publint/package/peer检查通过。

### 2026-08-31 · M2 dual cursors + Host-resolved focus

- 签署ADR-008：user cursor拥有主reader；Agent cursor来自cold-replayable标准tool projection，默认不抢位置；
- 新增strict`reader-focus-rpc.v1`与中英/TS/Python shape parity，focus ID必须等于immutable locator ID；
- authenticated`reader/focus`在sidecar前重验Session、Workspace和exact document/revision/representation/hash；
- Library阅读授权与SourceScope授权分别计算，结果可标记`library/source-scope/both`，不会隐式改变Scope；
- resolver候选固定最多5个；Host拒绝sidecar source identity drift，Client也做generation与identity复核；
- Follow默认paused，支持follow once/opt-in continuous；用户手动切文档或页即暂停；
- `resolved`移动到exact target，`page-only`只移动到已核验页；stale/ambiguous/missing/denied不移动不高亮；
- Markdown/plain原文只有唯一exact match才`mark`；重复/缺失文本保留证据rail并显式拒绝猜测；
- native PDF仅定位physical page并在rail显示exact quote；可控PDF图层前不声称bbox/paragraph高亮；
- layout breakpoint优先使用reader container的ResizeObserver，window media query仅作旧环境fallback；
- targeted contract/Host/Client suites 35 passed；full gate：25 JS files / 138 passed + 1 Azure skip，Python 65 passed；
- client bundle：84.21 kB / 19.02 kB gzip；publint、package、compat和protocol gate通过。

### 2026-08-31 · M2 AnswerManifest + CitationPresentation

- 签署ADR-009：不启第二模型、不新增DocAtlas Session event；同一个DSH Agent回答携带bounded factual-span标注；
- 新增strict `answer-manifest.v1` / `answer-rpc.v1`，含AnswerBlock/Segment、CitationPresentation、inline EvidenceAtom、
  verification summary、512 KiB ceiling与跨语言shape parity；
- span marker使用DSH会安全unwrap的fragment destination，正常Chat只显示用户可读原文，不产生可执行假链接；
- compiler只接受同turn、call ID确属`docatlas_read`、meta/Locator合法且exact SourceScope identity匹配的来源；
- `relationAssertedBy: agent`明确support/refute/qualify尚为Agent判断；`read-verified`只证明quote/Locator来源；
- unknown locator、malformed marker、scope drift、无exact quote、重复/越界均保持unresolved或fail closed；
- 未标注文本保留`unclassified-text` gap；不会把附近citation静默套到金额、日期或页码上；
- `agent/turn-stopping`在turn/end前写入immutable manifest；`docatlas.answers`仅在turn/end后发布message summary；
- Investigation store迁移到schema v2；已测v1幂等迁移、unknown-version fail-closed、manifest idempotency/hash/tamper检测；
- assistant message action按messageId惰性读取Manifest，accessible dialog逐span显示关系与gap，点击后重新走authenticated
  reader focus；当前DSH无action→openView owner时直接显示exact quote/original link，未来seam已保持typed handoff；
- 真实sidecar + scripted DSH Agent Loop验证单turn Search→locate→blocks→Manifest以及live/cold projection等价；
- 真实Azure GPT-5.6 Luna验收通过：模型生成完整命题Locator marker，Host产出read-verified Evidence；未映射页码被如实标成partial；
- full gate：29 JS files / 159 passed + 1 Azure conditional skip，Python 66 passed；isolated DSH rc.2 packed mount通过；
- client bundle：105.02 kB / 23.16 kB gzip；Host bundle 724.56 kB / 139.83 kB gzip；package/peer/compat/protocol gate通过。

### 2026-08-31 · M2 Source Scope Drawer

- 签署ADR-010：Library eligibility、active inclusion、actual tool use与final citation是不同事实；
- 扩展strict `source-scope-rpc.v1`：Host overview、bounded cursor和最多100个disjoint add/remove patch；
- Overview由Host聚合exact revision identity：eligible=current Library、included/excluded=active immutable scope、
  used=call-ID-correlated Search/Read、cited=persisted AnswerManifest；
- Library前进到新revision后，current eligible与historical included/used/cited分成两行，不按document name合并；
- candidate inbox尚无真实provider时明确返回`unavailable/0`，不把Library文件假报成candidate；
- patch只发送loaded delta，Host保留未加载source、role、exclusion和policy tags，并选择current representation；
- policy/permission/out-of-date/duplicate exclusion不可由drawer覆盖；user exclusion可显式重新纳入；
- patch request hash/result与scope journal/current projection同一SQLite transaction；Host生成时间，重启后精确replay，
  same-key/different-request、stale CAS、remove-last、busy Agent均fail closed；
- explicit Session unbind使用二次确认，保留旧Investigation；后续创建使用新的deterministic Investigation identity；
- DSH dynamic system-prompt context在每个Agent step生成standard superseding runtime-context snapshot；没有DocAtlas事件；
- Header drawer显示中英文本状态、current/historical/scope-only、role、exclusion reason、分页/filter与busy/read-only状态；
- scripted真实PDF Agent Loop验证prompt scope、used/cited聚合和无custom Session event；
- full gate：31 JS files / 165 passed + 1 Azure conditional skip，Python 66 passed；isolated DSH rc.2 packed mount通过；
- client bundle：128.87 kB / 27.54 kB gzip；Host bundle 760.88 kB / 145.84 kB gzip；package/peer/compat/protocol gate通过。

### 2026-08-31 · M2 atomic selection + context tray

- 修正并落实ADR-006：public rc.2已经暴露`conversation.input.dock`、structured reference、ReferenceCodec和
  span-CAS事件；compat probe锁定serialize-before-sink、serializer failure保留draft、user/message-before-request；
- 完成Host transient SelectionService：10分钟stage TTL、1分钟claim lease、每Session 16/全Host 256上限、
  192-bit cancel nonce hash与constant-time核对；
- stage从active SourceScope派生workspace/Investigation，逐项验证document/revision/representation/hash；
- text/table/multi-range由sidecar exact Resolve重新读取TextQuote；figure/page同时要求authenticated asset hash；
- 支持text/table/figure/page/multi-range typed proposal；原生PDF无受控selector时明确不可选，不伪造坐标；
- SelectionContext最多16项/64 KiB；长multi-range仅携带4,000字符preview与完整hash/count/Locator；
- Client Reader支持NFC文本选区、最多16个range、移除/键盘排序并按current active representation staging；
- resident composer上方Context Tray支持预览、expiry、cancel、`@`候选与draftRev span-CAS structured insertion；
- reference只携带session routing + stable context ID；clipboard/reload marker不含nonce，reload后自动CAS恢复structured chip；
- pre-step listener先等待所有downstream admission，再同步all-or-none claim、剥离marker、追加标准plugin-provenance
  `user/message`；`agent/request`只在消息已入日志后consume；
- duplicate/expired/replayed/wrong-session/stale-scope/permission/mixed-validity/concurrent claim均fail closed；
  stranded claim按Session log或lease恢复；status显式报告`stale`；
- real PDF scripted Agent Loop验证exact resolve、context进入首个model request、marker不进durable user message、nonce不进
  model/Session、consume发生在request边界；无DocAtlas custom Session event；
- full gate：34 JS files / 178 passed + 1 Azure conditional skip，Python 66 passed；isolated DSH rc.2 packed mount通过；
- client bundle：159.67 kB / 34.01 kB gzip；Host bundle 789.42 kB / 152.11 kB gzip；package/peer/compat/protocol gate通过。

### 2026-08-31 · M2 explicit selection actions

- 扩展strict Selection RPC：`save-evidence`、`create-note`、`open-question`、`propose-claim`各自为显式
  nonce-authorized/idempotent command，结果携带exact Locators、EvidenceAtoms与typed record；
- `save-evidence`从已重解析TextQuote/asset物化quote/table-cell/figure EvidenceAtom；page只有exact text时才允许
  visual-observation，asset-only不会伪装为观察结论；
- ResearchNote要求commentary/hypothesis/scratch类型与用户正文；OpenQuestion要求问题正文；
  ClaimProposal要求statement + support/refute/qualify且固定`proposed`，不产生ClaimVersion/accepted事实/Review；
- Reader支持Ask/Explain/Compare/Challenge/Translate/Calculate intent，同一个DSH Loop按SelectionContext收到
  明确指令；这些intent本身不写任何domain record；
- Context Tray提供独立Save Evidence/Write Note/Open Question/Propose Claim控件、输入label、44px touch target与
  “proposal不是事实”提示；刷新后无nonce时仍可Ask但写入按钮fail closed；
- SourceScopeStore升级schema v3，`selection-action.recorded`以独立aggregate journal exact result/context；
  只持久化canonical request hash，不落nonce；v1/v2 additive migration、unknown version fail closed；
- lost-response同request/key返回`replayed`，same-key/different-request冲突；selection consumed后仍可重放既有结果，
  但不能创建新动作；
- Store startup复核projection/journal/hash/identity，tamper失败；per-workspace最多10,000条action；
- real PDF Agent Loop在Ask前显式保存Evidence，验证quote/role/resolution、durable replay与Session中无custom event/nonce；
- full gate：34 JS files / 182 passed + 1 Azure conditional skip，Python 66 passed；isolated DSH rc.2 packed mount通过；
- client bundle：172.57 kB / 36.52 kB gzip；Host bundle 818.87 kB / 156.45 kB gzip；package/peer/compat/protocol gate通过。

### 2026-08-31 · M2 controlled PDF Reader + Compare

- 签署ADR-017；sidecar envelope升级为`1.2.0`、document RPC family升级为`1.1.0`；新增内部
  `read(mode=page)`，按physical page与`page_block_index`返回bounded blocks并支持page-bound cursor；
- Agent的`docatlas_read`仍只暴露`locate/blocks/expand/sequential/visual`五mode；`page`只服务Web Reader，
  不扩大模型tool surface，也不增加第二Agent Loop；
- 新增strict `reader-page-rpc.v1`：Browser只传Session/Workspace/document/revision/page/pixel budget/opaque cursor；
  Host核验live Session、Workspace membership、非归档current revision与active representation后调用page+visual；
- 响应只含blocks、Locators、text quality、page image asset metadata与pagination，不含路径/服务端URL；Client只用
  opaque asset ID构造既有authenticated asset URL；page-image授权再次绑定current revision/representation/hash/page；
- 原生PDF iframe已替换为PDFium页图+可选择HTML文本轨；empty/sparse/garbled/truncated均显式呈现，citation仅在
  exact document/revision/representation/hash/page/block及unique quote同时匹配时高亮，不在页图上伪造bbox；
- PDF文本选区复用既有SelectionContext，选中时固定physical page，之后翻页不会把选区错绑到新页；
- Compare提供两份exact current-revision PDF、两套独立page cursor；宽屏并排，窄屏A/B tabs；相同页码不触发
  同步或跨文档高亮，选区明确只属于主文档A；
- 新增Playwright 1.59.1 + axe browser gate：Chromium键盘选择/提交、44px controls、landmarks/labels、明暗主题
  serious/critical a11y、citation→exact block、1440/1024/390 breakpoints、reduced motion、Compare窄屏切换与
  独立翻页全部通过（4/4）；
- deterministic PDF矩阵覆盖born-digital、multi-page、landscape/rotated、multi-column、table、figure、
  scanned/no-text、encrypted、malformed、same-page cross-document十类；Python新增5 tests，总计71 passed；
- 本机另以`stress-reader-corpus.py`跑MMLongBench 10份真实多页PDF：10/10完成page+visual；再跑1份真实扫描
  PDF，15页中抽取前2页，正确报告`textQuality=empty / pageBlocks=0`且页图渲染成功；
- full gate：36 JS files / 193 passed + 1 conditional Azure skip；Python 71 passed；isolated DSH rc.2 mount通过；
- client bundle：202.25 kB / 41.16 kB gzip；Host bundle：829.45 kB / 157.86 kB gzip。

### 2026-08-31 · M3 governed Research Record + Recall vertical slice

- 签署ADR-011：Record只追加typed domain event，Recall只返回bounded lead，真正Review继续保留独立语义和gate；
- 新增strict `research-record-rpc.v1`与`research-recall-rpc.v1`及TS/Python schema parity；请求和结果无路径、
  数据库位置、旧Session transcript或accepted-fact字段；
- Investigation SQLite升级schema v4；`research-record.created`把Agent checkpoint/OpenQuestion固定标成
  `epistemicStatus=unverified`，并绑定exact Session、ScopeVersion与DSH tool call；
- `docatlas_record`的call provenance/idempotency由Host从DSH call ID派生，不接受模型自报routing；该tool不能写
  Evidence、accepted Claim、Decision、ResearchPolicy或Review outcome；
- selection产生的EvidenceBookmark/ResearchNote/OpenQuestion/ClaimProposal与Agent record共同进入可重建
  `research_recall_records` + Unicode FTS5 projection；journal/current rows仍是唯一truth；
- `docatlas_recall`只从当前Session的active Workspace/Investigation/Scope派生授权；跨Session限同Workspace，
  返回record status、bounded preview、exact source identity与`none/current/outside/mixed` source-state；
- 所有lead固定`unverified-lead`；source不在当前Scope时要求显式include+reverify。Evidence bookmark的原文不进
  cross-scope FTS，避免通过query命中探测未授权source content；
- cursor绑定normalized query、type filter、ScopeVersion与projection generation；新增记录后旧cursor fail closed；
  item/char/type budgets、Unicode tokenization、idempotent replay和tamper均有targeted tests；
- startup从hash-verified selection/research rows删除并重建Recall FTS；v1/v2/v3 additive迁移到v4；unknown版本、
  journal/current hash drift继续fail closed；
- 新增WAL-aware SQLite live backup：独立0700目录、0600文件，并复核quick-check、workspace identity和journal chain；
- scripted单DSH Loop验证Session A `docatlas_record`→Session B `docatlas_recall`，模型只看到unverified lead，
  Session Log无DocAtlas custom event、无第二模型/第二Agent Loop；
- 新增user-only `research/lifecycle` authenticated command：CAS edit、OpenQuestion resolve、archive、delete；每次
  变更追加versioned journal event，edit仍unverified，delete只留无正文tombstone并即时撤回Recall FTS；
- lifecycle目前覆盖Agent产生的checkpoint/OpenQuestion；旧selection-action中的Note/Question物化和显式restore仍在
  M3-005，避免在两套aggregate version语义未统一前制造不可回放的“删除”；
- full gate：40 JS files / 211 passed + 1 Azure conditional skip；Python 71 passed；
- client bundle：202.25 kB / 41.16 kB gzip；Host bundle：901.55 kB / 168.42 kB gzip。

### 2026-08-31 · M3 unified lifecycle + exact Tree Overlay

- 签署ADR-012：canonical parser tree/Block Map保持immutable；Tree Overlay只是Host-owned、可删除重建的
  read model，不向sidecar写tree mutation；
- Investigation SQLite升级schema v5；selection-action产生的ResearchNote/OpenQuestion沿原action aggregate
  进入同一CAS edit/resolve/archive/delete版本链，不另造version-1 truth；
- 删除selection或Agent record时，同一事务写无正文tombstone并撤回Recall FTS与所有Tree Overlay rows；编辑和
  resolve/archive更新显式status/preview，restart由journal/current rows恢复；
- v4 foreign-key布局变更前先checkpoint WAL并生成按Workspace隔离、0600、identity/journal验证过的迁移备份；
  migration transaction失败可保留原库与备份；
- 新增显式restore primitive：只接受absolute regular backup、复核current schema/workspace/foreign keys/journal，
  只写不存在的目标文件并使用`COPYFILE_EXCL`；绝不覆盖现有Investigation数据库；
- 新增strict `tree-overlay-rpc.v1`：请求绑定live Session/Workspace/Investigation/ScopeVersion和exact
  document/revision/representation/hash，可选physical page、record-type、item/char budget与opaque cursor；
- 一个record的每个Locator产生独立deterministic overlay item；当前Investigation标`working`，同Workspace旧
  Investigation标`research`；每项固定`anchor-only`，不能作为record解释为真的证据；
- Agent checkpoint/OpenQuestion没有Locator时只进Recall，绝不按文本相似度猜树锚点；同为p.2的不同文档或
  revision/hash无法串线；
- overlay/recall cursor绑定所有匹配projection-row hashes；任一edit/delete会使旧cursor fail closed；
- startup会清空并从hash-verified selection/lifecycle rows重建Overlay；测试主动删除projection后成功恢复；
- authenticated `research/tree-overlay` Browser RPC仅做read；`parentId/children/path`等tree mutation/path输入被
  strict schema拒绝；
- targeted覆盖selection Note edit/delete、selection OpenQuestion resolve、Working/Research layers、分页、cursor
  invalidation、wrong-source、backup→empty-target restore、v4→v5 backup-first migration；
- full gate：41 JS files / 217 passed + 1 Azure conditional skip；Python 71 passed；
- client bundle：202.25 kB / 41.16 kB gzip；Host bundle：929.22 kB / 172.04 kB gzip。

### 2026-08-31 · M4–M6 product closure

- M4 使用同一 Workspace Investigation SQLite 的 append-only hash journal；ClaimVersion CAS、canonical
  Selection Evidence、support/refute/qualify、G0–G4 deterministic Review、human sign-off 和 Brief/Matrix
  Publish 均由 9 个 authenticated RPC 驱动；Memory/Recall 永远不能成为 Evidence，人工批准不能覆盖 gate fail；
- M5 `ContinuityLink` 使用独立 append-only hash chain；Host 二次核验 record/workspace、active
  Workspace/Investigation/Scope、exact old/new source 和 current resolved Evidence；revision-impact cursor 绑定完整
  snapshot 并带不可编辑签名；历史 Library revision 可经 SourceScope CAS 显式重新纳入，不会被自动扩 scope；
- M5 四组纵向场景覆盖 financial continuing、contract changed、research conflicted、audit unknown，以及
  cross-workspace、outside-scope、missing/deleted/stale、Note 自证拒绝和 pagination identity；
- M6 使用物理隔离的 Profile SQLite ledger；Observation→Candidate→MemoryVersion→Decision→Use/Outcome、Probe、
  pause/resume/edit/forget/export 均可追溯；浏览器 actor 由 Host 映射，客户端自报 actor 无效；
- 新增 authenticated `personalization/inspect` 和 expiring export Fetch；Personalization Center 可展示双开关、
  active/paused preferences、exact why-used、Fact Trace guard、forget receipt 和可下载的 reference-only export；
- DSH Client 新增实际 `Research` view，接入 Claim Ledger、Review/Publish、Research Notebook/Continuity 和
  Personalization Center；Reader 仍保持原文、精确 citation focus、selection 问答和 Compare；
- Fact Trace on/off gate 固定同一 Claim/Evidence/Review/SourceScope backbone；个性化只改变阅读与呈现，不改变
  evidence support、contradiction disclosure 或 publication decision；
- 最终 workspace gate：65 JS files，376 passed + 1 conditional Azure skip；Python 74 passed；Playwright
  5/5；DSH 0.1.1-rc.2 isolated Host mount；generated contracts、runtime sync、lint、typecheck、build、publint、
  manifest、compat 和 protocol 全部通过。

M7 Providers/Studio/Collaboration 仍按计划 `deferred`，不计入本 release 的未完成项。

### 2026-09-01 · Chat-first product shell correction

- 明确区分可用的 DSH 工程壳与 DocAtlas 产品入口；不再把 workspace/session chooser 当作完成的产品 UI；
- 新增真实 chat-first 空态：一个居中问题框直接调用 scoped DSH Conversation service，首条消息、取消、后续
  Agent Loop 与 Session log 仍完全由 DSH 拥有，没有第二套 conversation；
- 新增克制的 DocAtlas wordmark、暖白/墨绿视觉 token、折叠历史侧栏和产品标题；没有插图、渐变或 dashboard 卡片；
- 产品 profile 隐藏 Session Log 下载、system prompt、Turn token/耗时、model/permission、Plan、feedback 和
  Trajectory 等开发者控件；Library、Source Scope、Chat 与 Original Source 保持可达；
- citation 主路径实测：回答 `[1]` → authenticated focus resolve → `sample_report.pdf` physical page 2 →
  exact text highlight → 同一 Session 右侧 Evidence Chat；页面无 console/page error；
- Azure GPT-5.6 Luna 实测从新首屏发送 `只回复：DOCATLAS_PRODUCT_READY`，真实回答到达且 landing 退出；
- alpha 开发安装脚本先移除 profile-local 旧 tarball 再安装，防止相同本地路径/版本复用 stale client bundle。
- 运行反馈修正：新增 `docatlas` 专属 Agent preset，默认 `read-only + ask`，工具清单实测只有
  `ask_user_question` 与 `docatlas_search/read/recall/record`；不再注入仓库 `AGENTS.md`，也不存在 Bash 升权路径；
- 旧环境中遗留的 `permission.defaultPreset=danger-full-access` 和 `agent-presets.default=standard` 已改为
  `read-only` / `docatlas`；变更只作用于新 Session，保留历史 Session 的可审计工具与权限记录。

### 2026-09-01 · Explicit @document admission + original PDF citation focus

- Session Log 还原确认：chat-first textarea 曾把 `@DocAtlas-Harness/data/sample_report.pdf` 作为普通文本直接
  submit；Agent 虽获得用户确认，但 Source Scope mutation 不是模型工具，因此第二次 Search 仍然必然失败；
- 签署 ADR-020：显式 `@document` submit 是用户纳入动作，但浏览器仍不能提交路径；Client 只用名称查询，
  Host 返回 expiring opaque candidate 并负责 configured-root containment、materialize 与 hash；
- 发送前链完成 Library exact reuse/import、sidecar build-spec refresh、idle Source Scope CAS，再进入同一个 DSH
  Conversation；missing/ambiguous/busy/import failure 均保留 draft 且不产生 Agent turn；
- PDF ingest 增加 `pdf-visual-lines-v1` 细粒度证据块；PDFium 在 immutable original asset 字符层做唯一匹配，
  从真实 char boxes 生成 top-left ratio bbox；rotated/duplicate/missing/invalid geometry 不画框；
- Evidence Desk 只在 authenticated 原始 PDF 页图上绘制 verified bbox；此时 extracted text rail 不再同时高亮；
- 真实 Azure 回归：原始问题一次提交即得到 active Scope version 1，顺序读取6页并生成16条 citation；Q4 citation
  定位 physical page 2，原 PDF 高亮框为 `left 13.18% / top 32.41% / width 54.03% / height 1.03%`，文本轨0个mark。
- full gate：67 JS files / 386 passed + 1 conditional skip；Python 76 passed；Reader Playwright 5/5；lint、
  typecheck、build、publint、compat、generated contracts、packaged sidecar 与跨语言协议全部通过。

## 每个工作包的完成检查

1. 目标与非目标明确；
2. 先有 contract/fixture，再扩大行为；
3. 不覆盖无关或用户已有变更；
4. unit/contract/integration 测试与风险相称；
5. `git diff --check` 对相应下游 checkout 通过；
6. `bash scripts/check.sh` 通过；
7. 涉及 Azure/browser/live provider 时执行单独 opt-in smoke；
8. 更新本任务板的状态和验证证据。

