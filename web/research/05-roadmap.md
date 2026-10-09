# DocAtlas × DSH 实施路线图

> 状态：Supporting milestone detail；当前执行顺序、完成度和统一验收以
> [完整实施主计划](../docs/implementation-plan.md)为准。
> 研究日期：2026-08-29  
> 原则：先稳定 identity/evidence contract，再扩大 UI；Personalization Kernel 从领域设计与 observation
> 开始并行建设，Fact Trace 稳定后才扩大其决策影响；每个阶段都有可回滚的纵向切片。

## 结论先行

推荐实施顺序由一条串行路线改为两条受门槛约束的 track：

```text
Evidence/Research: M0 identity → M1 read slice → M2 Evidence Desk → M3 Claim/Research Memory/Publish
Personalization:    K0 domain   → K1 observe    → K2 explicit prefs → K3 candidate/control
                                                                │
                                                                └→ M4 controlled adaptation
                                                                     → M5 providers/Studio/collaboration
```

K0–K3 是 DocAtlas 原生 Personalization Kernel 的基础，不需要等 Claim Ledger 全部结束；M4 是在事实门槛
通过后激活 workflow learning、personalized Lens 和 plan/ranking 影响，而不是第一次开始实现 Memory。
详细边界见[DocAtlas 原生个性化架构提案](10-docatlas-native-personalization.md)。

这里的 K track 只表示 Personalization Memory。用户已经完成的 Evidence/Claim/Note/Decision/OpenQuestion
属于通用 Research Memory，随 M0–M3 的 Evidence/Investigation track 建立；关闭个性化也必须继续工作。
受控偏好校准和跨文档 recall-to-reverify 见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。
Note、Review、Memory 不预设为同一套 tool CRUD；其独立价值、组合场景和 record/recall/verify 备选见
[Note、Review、Memory 设计空间](15-note-review-memory-design-space.md)。

最重要的 P0 不是页面，而是把现有 `evidence.source = "Page 2, ..."` 升级为
`documentId + revisionId + physicalPage + optional quote/bbox/figureRef`。当前多文档 enrichment 只按页码
找第一个覆盖节点：两份报告都有 p.2 时，第二份的 finding 可能写进第一份 tree。没有这个修复，Web
citation 越漂亮，错误定位越具有迷惑性。

## 1. 当前目录与未来目录

当前保持研究、协议、插件与 sidecar 边界隔离：

```text
DocAtlas-dsh/
├─ DocAtlas-Harness/                         # 独立 Git、可修改的下游 DocAtlas core
├─ .sources/                                 # ignored、按 commit 固定
├─ contracts/                                # 当前只有 sidecar health wire schema
├─ packages/contracts/                       # TypeScript binding
├─ plugins/docatlas-dsh/                     # 空 Host/Client entry + DSH manifest
├─ python/docatlas-sidecar/                  # uv-managed JSONL health process
├─ compat/                                   # runtime/npm baseline matrix 与 probes
├─ evals/                                    # milestone-owned fixtures 说明
├─ research/                                 # 本轮设计结论
├─ scripts/                                  # bootstrap / checks / source maintenance
├─ package.json / pnpm-lock.yaml
├─ pyproject.toml / uv.lock
├─ sources.lock.json
└─ README.md
```

M0 contracts 获批后再扩展：

```text
DocAtlas-dsh/
├─ contracts/
│  ├─ document-locator.schema.json
│  ├─ evidence.schema.json
│  ├─ claim.schema.json
│  ├─ provenance-activity.schema.json
│  ├─ artifact-manifest.schema.json
│  ├─ tool-meta.schema.json
│  ├─ projection.schema.json
│  ├─ memory.schema.json
│  └─ sidecar-protocol.md
├─ plugins/docatlas-dsh/
│  ├─ src/contracts/
│  ├─ src/host/{providers,tools,projection,personalization-adapter,transport,sidecar}/
│  ├─ src/client/{model,views,toolviews,styles}/
│  └─ tests/{contract,host,client,e2e}/
├─ python/docatlas-sidecar/
│  ├─ pyproject.toml
│  ├─ src/
│  └─ tests/
├─ compat/
│  ├─ dsh-matrix.json
│  └─ probes/
└─ evals/
   ├─ claims-and-citations/
   ├─ personalization/
   ├─ citation-navigation/
   └─ longitudinal/
```

不复制 DSH 源码进插件；不把 `.sources` 作为编译依赖。插件只依赖发布的 DSH packages 和记录过的
peer range。

环境骨架已经先行建立这些目录，但其中只包含 health protocol 和空 Host/Client entry；这不代表 M0
Document/Evidence/Claim contracts 已获批准。

`personalization-adapter` 只是暂定的 DSH 接缝，不是 Memory 领域实现。DocAtlas Personalization Kernel 的
最终 Host/Python/SQLite 物理边界需由 ADR 决定；逻辑 ownership 不因此改变。

## 2. M0：Evidence identity 与中立 contracts

### 2.1 Document identity

```ts
interface DocumentRevision {
  documentId: string          // stable logical document id
  revisionId: string          // immutable content hash/provider revision
  displayName: string
  mediaType: 'application/pdf'
  byteLength: number
  sha256?: string
  provider: string
  pageCount?: number
}
```

路径和文件名是 metadata，不是 identity。替换同名 PDF 必须产生新 revision；旧 citation 仍指向旧版，
不能悄悄重锚到新 bytes。

### 2.2 Source representation 与 Evidence v2

```ts
interface SourceRepresentation {
  id: string
  documentId: string
  revisionId: string
  kind: 'page-image' | 'embedded-text' | 'ocr-text' | 'derived-markdown' |
        'table-extraction' | 'figure-crop' | 'model-description'
  contentHash: string
  generator?: { name: string; version: string; configHash: string }
  derivedFrom?: string[]
}

interface EvidenceAtom {
  id: string
  representationId: string
  kind: 'quote' | 'table-cell' | 'figure' | 'visual-observation'
  locator: {
    documentId: string
    revisionId: string
    page: number
    quote?: { exact: string; prefix?: string; suffix?: string; normalizedHash: string }
    position?: { start: number; end: number }
    bbox?: { x: number; y: number; width: number; height: number; unit: string; rotation: number }
    table?: { tableId: string; row?: number; column?: number }
    figureRef?: string
    blockId?: string
  }
  content: string
  contentHash: string
  createdBy: 'agent' | 'user' | 'import'
}
```

legacy `found`、`plan` 与 `evidence` 分离；ClaimVersion 引用 evidence ids，不把 source string 再解析一遍。

### 2.3 Legacy migration

- `"Page N"` 只能在 session 恰好一个 document revision 时自动升级；
- source 含可唯一解析的 doc id/name 时可升级，并保留原字符串；
- 多文档且含糊时标 `unresolved`，不默认归给第一份文档；
- tree annotation 先定位 document root/revision，再在其内部找 finest page node；
- page 超界、revision 缺失、quote hash 不符都返回结构化错误。

### 2.4 M0 tests

- 两份报告都含 p.2，分别保存 legacy finding/新 Claim，必须写到各自 root；
- 同名不同 revision 的 citation 不串；
- legacy 单文档可升级，多文档含糊拒绝；
- bbox 在 rotation/crop 后 round-trip；
- physical page 为 1-based，磁盘 `page0` 转换只在 provider boundary；
- evidence JSON 跨 Python/TypeScript round-trip 不丢字段。

### 2.5 Exit gate

Python-neutral JSON Schema、TypeScript type 和 Python dataclass/validator 对同一 fixture 全部通过，才进入
M1。不要先让 UI 自己发明 locator。

## 3. M1：DSH 插件纵向切片

### 3.1 范围

- 一个静态 Host/Client plugin package；
- `docatlas_search`、`docatlas_read` 两个只读工具；
- 一个本地 PDF/document revision；
- 一个新增 `conversation.view id=docatlas`；
- 一个自有 tool view；
- DSH Agent Loop 完成“问题 → search → read → answer”；
- reload 后 Session Projection 恢复已读页和 agent cursor。

`docatlas_read` 保持一个 Agent tool，通过 `locate / blocks / expand / sequential / visual` mode 提供渐进式
访问；不再另加 block-locate tool。当前 DocAtlas-Harness 本地 spike 已验证 legacy compatibility、bounded
preview、block selection、sequential cursor 和 visual-no-duplicate-markdown，详见
[Progressive Read 实验记录](12-progressive-read-spike.md)。正式接入仍以 revision-bound Locator contract 为门槛。

Web Reader另通过同一sidecar `read` RPC使用内部`page` mode，按`physical_page/page_block_index`取一页的
bounded blocks；它不进入Agent tool schema，因此不会扩大模型选择空间或改变上述五mode产品契约。

### 3.2 Python bridge

先复用现有 Skills 的 JSON-over-stdio 窄腰，但删除其中 Agent Loop/模型所有权：

- Host spawn 使用明确 executable/argv，不经过 shell；
- Python 环境只用 `uv sync --locked` / `uv run --locked`；
- request/response 有 schema version、request id、session id、document set id；
- DSH AbortSignal 终止子进程，超时后确保 reap；
- stdout 只有协议 JSON，stderr 是 bounded diagnostics；
- credentials 默认不传给 read provider。

在 p95 延迟证明 Python 冷启动不可接受后，再换长驻 sidecar；不提前做 daemon orchestration。

### 3.3 Tool meta 与 Projection

M1 只 fold 现有：

```text
tool/call(docatlas_*) + tool/result(meta schema v1) + turn/end
```

不新增 custom Session Event。Projection 至少给 Client：

```ts
interface DocAtlasSessionProjectionV1 {
  schema: 'docatlas.session.v1'
  documentSetId?: string
  documents: DocumentRevisionRef[]
  reads: ReadActivity[]
  agentCursor?: DocumentLocator
  claims: ClaimSummary[]
  citationsByMessage: Record<string, string[]>
}
```

### 3.4 Host/Client transport

- mutation/JSON query：authenticated custom `ctx.connection` RPC channel；
- PDF/page/figure：authenticated exact `/api/docatlas-*` Fetch routes；
- 禁止直接传任意 absolute path；
- 每个请求验证当前 session/documentSet 对 documentId 的访问；
- Range、ETag、HEAD 与 cancellation 有 contract tests。

### 3.5 M1 exit gate

- 干净 DSH profile 安装 link/tarball、`--dump-config`、启动 Web；
- 用户在原生 composer 提问，DSH 模型确实调用 `docatlas_*`；
- 刷新、冷打开、fork 后 projection 行为符合策略；
- 卸载插件后旧 Session 仍能由 DSH 打开，DocAtlas tool rows 退回 generic renderer；
- 没有 DocAtlas sidecar 时工具给可行动错误，DSH 其余功能正常。

## 4. M2：Evidence Desk

### 4.1 首版 UI

- Documents + Outline 左栏；
- PDF source 与 Markdown extracted view；
- Investigation 右栏；
- user/agent 双 cursor 和 Follow；
- claim/evidence click-to-source；
- assistant action “查看来源”；
- responsive desktop/mobile；
- DSH composer 常驻。

### 4.2 选区提交 spike

这是 M2 唯一需要先做 prototype 决策的点：如何让 reader 选区与下一条 direct user message 原子绑定。
验证公开 composer/context surface；若不足，采用 nonce staging + `agent/pre-step` 一次性消费。必须测试：

- 用户选择 A，修改问题，提交后只绑定 A；
- 选择 A 后切 session，不能泄漏；
- stage 后未提交而刷新，明确恢复或过期；
- queue/steer 并存时绑定正确 message；
- cancellation/重复提交不重放选区。

### 4.3 Citation acceptance

- bbox 命中：精确高亮；
- quote 命中：文本层高亮；
- 只有 page：页级 pulse 并标“页级引用”；
- revision 不可用：显示来源缺失，不跳到同名新文件；
- citation focus 缓存命中 p50 <200ms；
- PDF 与 Markdown 都能回到相同 Evidence id。

### 4.4 Exit gate

用至少 10 份不同类型 PDF 做真实 E2E：文本、扫描、双栏、旋转页、表格、图像、长文档、同名 revision、
多文档同页码、无 Markdown fallback。无 P0 错定位才进入 Claim Ledger。

## 5. M3：Claim Ledger、Verify 与 Publish

这一阶段把“有引用的回答”升级成“可维护的事实工作”。详细模型见
[Fact Trace 与可交互 Agent Loop](07-fact-trace-agent-interaction.md)。

- `EvidenceAtom`、`ClaimVersion`、support/refute/qualify relation；
- Claim edit/split/merge/version history；
- 正交的 epistemic status、review status 与 lifecycle status；
- Contradiction Inbox 与 query coverage；
- calculation/compare derivation 可复现；
- Explore answer 与 Published Evidence Brief 双模式；
- `docatlas_record` / `docatlas_verify` / `docatlas_publish_brief`；
- versioned `ArtifactManifest`，每个 factual span 映射 claim version；
- optional human sign-off；
- source revision 更新触发 selective revalidation，而不是全量重生；
- typed ResearchNote、ProjectDecision 和 OpenQuestion，不再用一个自由文本 Note 混合所有语义；
- 同 workspace 的 Related prior work，只返回 bounded lead，再 re-resolve/reverify 原 Evidence；
- Research Continuity 与 Personalization 使用正交开关，跨 source scope 必须显式扩展。

### 5.1 Investigation Journal ADR

进入 M3 前必须签一个 ADR：

| 方案 | 可接受范围 | 不可接受范围 |
|---|---|---|
| 只靠 DSH tool events | 可回放 Agent 工具 | 无法完整承载人类 UI claim edit/review |
| plugin SQLite append-only journal（推荐） | Claim/Evidence/Artifact 事务、version、FTS、audit | 不替代 DSH conversation log |
| 外部 evidence service | 团队/云端大规模协同 | 首版本地单用户的强依赖 |

推荐第二种。DSH Session Log 保持对话/Agent 真相，Investigation Journal 保持 DocAtlas 领域真相，双方用
session/turn/step/callId 与 ids/hashes 交叉引用。数据库 migration 必须 transactional、backup-first、
unknown version fail-closed。

### 5.2 Exit gate

- 每个 published factual span 映射 ClaimVersion；
- selector integrity、citation completeness/precision、scope 和 conflict gates 通过；
- Claim edit 产生新 version，旧 artifact 仍可复现；
- derived note/artifact 不能循环支持祖先 claim；
- legacy factual Note 以 `unverified` 导入，不能直接成为 EvidenceRelation source；
- 至少一条旧 Claim/Note → locator re-resolve → 当前/历史 evidence comparison 闭环通过；
- `unknown/not-found/negative` 三种状态不会混淆；
- human review actor/time/scope 可审计；
- crash/restart 后 DSH Log 与 Investigation Journal 交叉引用完整；
- 至少一条双文档 comparison brief 从原文到 sign-off 完成 E2E。

## 6. M4：受控个性化激活与纵向学习

K0–K3 已随前序里程碑建立 schema、observation、显式设置和 candidate governance。M4 在 Fact Trace
non-regression gate 通过后，逐步扩大这些 DocAtlas 原生能力的作用面：

- stable profile：语言、回答密度、evidence policy；
- reader preferences：PDF/Markdown、栏宽、字号、follow；
- Personalization Center：candidate/active、scope、provenance、edit/forget/export；
- 每个受影响的 plan/artifact 显示 why-used；
- read-only `docatlas_memory_recall`；
- turn-end bounded candidate extractor，默认 opt-in beta；
- 重复 observation 聚合；
- preference correction/temporal validity；
- workflow/negative lesson；
- lexical + optional semantic/RRF recall；
- utility feedback，不把 access count 当 truth；
- personalized Lens 与 reading strategy explanation。

### 6.1 Promotion policy

- UI explicit setting：直接 active，可 undo；
- “以后…”明确偏好：candidate + 一键确认；
- 推断偏好：跨 ≥2 sessions、≥3 observations 才进入 inbox；
- constraint/sensitive：永远明确确认；
- verified provider/document failure：document-revision-scoped negative lesson + TTL；
- assistant-only statement：不可自动 promotion。

### 6.2 Longitudinal eval gate

LongMemEval 五类 + DocAtlas 自有场景必须进入 CI/nightly。至少报告：candidate precision、harmful-use、
update/abstention、provenance resolution、personalization adherence、evidence non-regression、token/latency。
评测不能停在 memory QA；还必须分段评分 Observation、promotion、recall admission、
`PersonalizationDecision`、Agent action 和 `MemoryUse/Outcome`。baseline、纵向场景和指标见
[个性化实现研究与验证方案](11-personalization-implementation-research.md#11-docatlas-专属评测计划)。

“用户感觉更懂”之外，必须证明错误 memory 不会让文档答案更差。

另加硬门：personalization on/off 时，Claim support/refute、selector resolution 和 publication gates 的结果必须
完全一致；只有 ranking、plan、explanation 与 presentation 可以变化。

### 6.3 Memory storage ADR

| 方案 | 可接受范围 | 不可接受范围 |
|---|---|---|
| storage-domain only | bounded stable profile、少量 UI prefs | 复杂 candidate/version/usage transaction 与 FTS |
| storage-domain profile + SQLite memory ledger（推荐） | topic/version/provenance/use audit/migration | 仍不默认宣称加密或多用户身份 |
| 外部 memory service | 企业团队同步、共享 graph | 首版本地单用户的强依赖 |

Memory ledger 与 Investigation Journal 可以共用一个 DocAtlas-owned SQLite 数据库中的独立
schema/transaction boundary，也可以分库；任何情况下 Document Claim 与 Personal Memory 都必须保持
类型和查询边界分离。数据库由 Host 还是 sidecar 持有，留给 runtime/storage ADR；DSH storage 只是底座。

## 7. M5：Provider、Evidence Studio 与协作

按使用数据决定顺序：

- PageIndex Cloud provider；
- local Flash provider；
- Compare Lab 与 Evidence Matrix；
- Investigation Map；
- Brief → slide/audio/study guide（共享 ArtifactManifest）；
- project publish/activity feed；
- 团队 comment/flag/sign-off；
- source update impact analysis；
- query/personalized Lens；
- memory import/export adapters；
- 可选团队 memory spaces；
- always-on background agent 只产生 candidate updates；
- 上游 additive sidecar slot proposal。

PageIndex managed chat 不在计划内；DSH 继续拥有 Loop。PageIndex File System 的 virtual/query-dependent
tree 只作设计参考，直到公开 SDK 有可验证契约。

## 8. Contract test 分层

| 层 | 测试 |
|---|---|
| Schema | JSON fixtures 跨 Python/TS，版本、上限、错误码。 |
| Provider | local/PageIndex capability matrix、budget、cancel、partial result。 |
| DSH Host | tools、approval、pre-step、projection、storage、connection auth。 |
| DSH Client | slots、model baseline/reconnect、focus request、responsive state。 |
| Replay | live → flush → restart → cold follow → projection 相同。 |
| Browser E2E | 真实 PDF、提问、tool、citation、selection、refresh、mobile。 |
| Migration | DB/profile/evidence legacy fixtures、backup、rollback、unknown version。 |
| Security | path traversal、SSRF、PDF/Markdown injection、secret、cross-session leak。 |
| Eval | document QA、citation precision、longitudinal personalization。 |

Python commands exclusively use `uv`; DSH/plugin JavaScript follows各自声明的 pnpm/npm。固定 PageIndex source
带 Poetry metadata，只做源码研究；在本项目实际执行前必须适配成 uv-managed sidecar，不能混用 Poetry/pip。

## 9. DSH 升级维护流程

### 9.1 固定与发现

```bash
bash scripts/check_source_updates.sh
bash scripts/sync_sources.sh
```

`check` 只报告 remote head，不自动改 pin。`sync` 保留 dirty checkout：已有源码研究修改时拒绝切换；
刚 clone 的 checkout 才允许首次强制 detached checkout。

### 9.2 每次升级审查的路径

```text
packages/core/{agent-loop,session,tools,system-prompt}
packages/session/{session-projection,session-projection-cache,session-persistence}
packages/storage/{storage-domain,storage-json,storage-sqlite}
packages/client/{connection,ui-slots,ui-conversation,ui-layout,ui-tool}
packages/api/{gateway,remotes,session-controller}
packages/extensions/{cordis-host-runner,cordis-client-runner}
apps/cli plugin/profile loading
```

先审 source diff，再更新 lock；不要通过“装 latest 看能不能跑”发现 breaking change。

### 9.3 Compatibility matrix

建议记录：

```json
{
  "dshTag": "dsh-v0.1.2-alpha.1",
  "dshCommit": "cd5ef814...",
  "pluginVersion": "0.x.y",
  "node": "24.x",
  "os": "linux-x64",
  "contractSuite": "sha256:...",
  "browserE2E": "passed",
  "testedAt": "..."
}
```

“兼容 `>=x`”只能覆盖实际 matrix 加上能证明的 semver contract；DSH alpha 阶段优先声明精确已测 tags。

## 10. 发布与回滚

- `dev`：link 安装，独立测试 profile 和测试 storage root；
- `canary`：固定 DSH tag + 固定插件 tarball，真实文档但隔离 memory；
- `stable`：签名/校验和、SBOM、migration notes、兼容 matrix；
- 每次数据库 migration 前自动备份，但恢复是显式用户动作；
- plugin remove 不删除数据；purge 是独立、确认、解析精确路径的动作；
- 旧插件遇到新 schema 必须 fail-closed，不能悄悄重建空库；
- 发布验收用最终 tarball 在干净 profile 安装、启动、实际点击 citation，不以源码测试替代。

## 11. 风险登记

| 风险 | 当前控制 |
|---|---|
| DSH slot/API alpha 变化 | source pin、contract probe、精确兼容 matrix。 |
| custom event 导致旧 session 无法加载 | 首版只用标准 tool events。 |
| 多文档页码串线 | M0 authoritative document/revision locator。 |
| Python 双 Loop | sidecar contract 禁止模型/对话所有权。 |
| PDF/Markdown prompt injection | untrusted data framing、sanitize、evidence-only context。 |
| memory poisoning | candidate、approval、provenance、scope、version chain。 |
| memory 造成 filter bubble | canonical Lens、一部分 non-personalized exploration budget。 |
| localStorage 丢研究状态 | 只存 presentation preference；证据/会话在 Host。 |
| 裸 Web route 暴露数据 | 使用 authenticated Connection channel。 |
| storage-domain 无 migration | profile 简单可重建；复杂 ledger 用 transactional SQLite。 |
| citation 存在但不支持 claim | atomic claims + citation completeness/precision gates。 |
| derived artifact 自我引用 | provenance DAG 和 no-self-support invariant。 |
| background agent 静默改结论 | 只产 candidate claim/artifact revision，发布需 review。 |
| 社区实现依赖私有 DOM/API | 只借鉴产品模式，生产代码只用 published seams。 |

## 12. 近期可执行清单

1. 审批 `DocumentRevision`、`SourceRepresentation`、`DocumentLocator`、`EvidenceAtom`、`ClaimVersion`、`ArtifactManifest` 六个核心 contract。
2. 在 `DocAtlas-Harness` 单独修复 multi-document tree enrichment，并添加双文档同页测试；完整上游
   `6786a17a` 的 165 项测试虽全部通过，但只读探针已确认 `b.pdf/Page 2` 会写入第一份文档的
   `D000_0001`，现有 suite 没有覆盖该条件。
3. 做 DSH plugin skeleton：静态 Host/Client、一个 `conversation.view`、一个 noop tool。
4. 验证 tool meta → Session log → cold projection → Client focus 的完整链路。
5. 验证 authenticated custom RPC/Fetch 和 PDF Range。
6. 接入 `docatlas_read` 的一个本地 PDF vertical slice。
7. 做 Evidence Desk 最小三栏和一个 selection → EvidenceAtom 流程。
8. 完成“一条 claim → 两条 evidence → 一次人工复核 → 一个 published brief”的最小闭环。
9. 实现同 workspace `ResearchRecallLead → source scope confirmation → re-resolve/reverify → ContinuityLink`
   的最小 Research Memory 闭环。
10. 再扩展双文档 Claim Matrix 和 contradiction handling。
11. 现在并行审查 DocAtlas Personalization Kernel 的 ownership、Observation Envelope、scope 与
    `MemoryUse` contract；M1/M2 只接收显式或确定性 observation。
12. Fact Trace non-regression gate 通过后进入 M4，才允许 personalization memory 影响 Lens、reading plan 和 ranking；
    verifier、selector 和 publication gate 始终不受影响。

这些步骤完成前，不建议先做 Audio/Video、知识图谱画布、团队记忆或自由分栏；它们无法修复 identity、
fact trace 和 replay 的基础错误。
