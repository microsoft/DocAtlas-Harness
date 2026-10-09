# Fact Trace 与可交互 Agent Loop：DocAtlas 的核心状态模型

> 调研日期：2026-08-29  
> 核心判断：DocAtlas 不应建立一个叫“事实库”的字符串集合，而应建立一个能表达证据、主张、冲突、推导、版本与人工裁决的 Claim Ledger。

## 结论先行

文档系统里不存在脱离来源和范围的“事实”。更准确的对象是：

```text
Source Revision       某一版可复现的原始材料
Specific Evidence     该版本中的具体页、quote、bbox、cell、figure
Claim                 对材料作出的一个可判断主张
Support Relation      evidence 如何支持/反驳/限定 claim
Derivation            claim 如何由 evidence 或其他 claims 推导
Review Decision       人或规则如何接受、纠正、争议、撤回
Artifact Use          哪个 answer/report/cell 使用了哪个 claim version
```

Citation 只是 `Claim → Evidence` 关系的一个可见投影。没有 Claim 层，就无法可靠回答：

- 一个句子里哪部分有支持、哪部分没有？
- 两份文件是在矛盾，还是时间、口径、jurisdiction 不同？
- 用户改了 report 中一个数字，其他 artifact 是否也该更新？
- 新版 PDF 到来后，哪些结论已经 stale？
- 一条个性化 memory 只是改变写法，还是错误地参与了事实证明？

因此推荐 DocAtlas 的核心从现有 `Search → Read → Note → Review` 升级为：

```text
Navigate → Observe → Claim → Verify/Challenge → Review → Publish
```

旧四个 Skill 仍然是很好的人机动作原型，但 Note 中自由文本 `source: "Page N"` 必须被结构化 Evidence/Claim 取代。

当 Evidence-linked Claim、Note、Decision、OpenQuestion 和 Artifact 跨 investigation 保留并可重新召回时，
它们构成 DocAtlas 的 **Research Memory**。这是 Fact Trace/Investigation Core 的持久研究能力，不属于
Personalization Memory；旧对象进入新回答前必须执行 recall-to-reverify。完整场景和 contract 输入见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

## 1. Evidence 不是 Fact

### 1.1 Source representation 层

同一 PDF 至少可能有：

- 原始 bytes 与 page image；
- PDF text layer；
- OCR text；
- Docling/MinerU Markdown；
- table/figure extraction；
- LLM image description。

它们不是同等权威。OCR 句子可能识别错，table extraction 可能错列，image description 是模型解释。建议：

```ts
type RepresentationKind =
  | 'original-bytes'
  | 'page-image'
  | 'embedded-text'
  | 'ocr-text'
  | 'derived-markdown'
  | 'table-extraction'
  | 'figure-crop'
  | 'model-description'

interface SourceRepresentation {
  id: string
  documentId: string
  revisionId: string
  kind: RepresentationKind
  generator?: { name: string; version: string; configHash: string }
  derivedFrom?: string[]
  contentHash: string
}
```

引用 OCR text 时，同时允许打开 page image。模型 description 永远不能伪装成 source quote。

### 1.2 Selector 使用多个互补锚点

[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)已经给出很成熟的模式：Annotation 是 Body 与 Target 的关系；Specific Resource 通过 Selector 指向 source 的片段，并通过 State 指定 source 的正确版本。它允许多个 selectors 描述同一内容，例如 Text Quote、Text Position、Fragment，并指出 position 对内容变化很脆弱，应与 state 配合。

DocAtlas 不需要直接采用 RDF，但应吸收其语义：

```ts
interface EvidenceSelector {
  page: number                    // physical PDF page, 1-based
  quote?: {
    exact: string
    prefix?: string
    suffix?: string
    normalizedHash: string
  }
  position?: { start: number; end: number; representationId: string }
  bbox?: {
    x: number; y: number; width: number; height: number
    unit: 'pdf-point' | 'ratio'
    rotation: 0 | 90 | 180 | 270
  }
  blockId?: string
  table?: { tableId: string; row?: number; column?: number }
  figureRef?: string
}
```

解析优先级不是固定只选一个，而是用多个 selector 互相校验：revision + page 先选 state，bbox/position 定位，quote hash 检查内容。如果不同 selector 指向不同文本，Evidence 标记 stale/ambiguous，不静默选一个。

### 1.3 Evidence Atom

```ts
interface EvidenceAtom {
  id: string
  representationId: string
  selector: EvidenceSelector
  content: string                 // bounded excerpt / serialized table cell
  contentHash: string
  evidenceKind: 'quote' | 'table-cell' | 'figure' | 'visual-observation'
  createdAt: string
  createdBy: ActorRef
  provenanceActivityId: string
  status: 'active' | 'stale' | 'unresolvable' | 'withdrawn'
}
```

Evidence Atom 只说明“这个 source state 中有这个内容”，不说明它支持哪个结论。

## 2. Claim 是最小可判断单元

[FActScore](https://arxiv.org/abs/2305.14251)说明一句自然语言常同时含多个 supported/unsupported pieces，因此事实追踪单元必须比 paragraph 或 sentence 更细。

```ts
interface ClaimVersion {
  id: string
  chainId: string
  version: number
  displayText: string
  proposition?: {
    subject?: string
    predicate?: string
    object?: JsonValue
    value?: number
    unit?: string
    polarity?: 'positive' | 'negative'
    modality?: 'asserted' | 'estimated' | 'possible' | 'required' | 'prohibited'
  }
  scope: {
    documentSetId: string
    entityIds?: string[]
    jurisdiction?: string
    section?: string
  }
  validTime?: { from?: string; until?: string }
  epistemicStatus: ClaimEpistemicStatus
  reviewStatus: 'unreviewed' | 'accepted' | 'needs-changes' | 'rejected'
  lifecycleStatus: 'current' | 'superseded' | 'archived'
  previousVersionId?: string
  createdBy: ActorRef
  createdAt: string
  provenanceActivityId: string
}

type ClaimEpistemicStatus =
  | 'proposed'
  | 'supported'
  | 'partially-supported'
  | 'contested'
  | 'contradicted'
  | 'unresolved'
  | 'stale'
  | 'withdrawn'
```

不要使用一个看似精确的 `confidence: 0.87` 替代原因。UI 应展示：支持覆盖、citation relevance、source authority、corroboration、conflict、freshness 和 human review 是哪些状态。

epistemic、review 与 lifecycle 必须正交：一个 Claim 可以同时是 `supported + accepted + current`，也可以是
`contested + accepted + current`（人确认“材料确实存在争议”）。不能用一个 `reviewed` 枚举值覆盖掉
原来的事实状态。

### 2.1 `unknown`、`not found` 与 `false`

这是专业文档中最危险的错误之一：

- source 没有提到 X：`not-found-in-reviewed-scope`；
- source 明确说 X 不存在：negative claim；
- parser 得到 null：unknown；
- Agent 没读到相关页：insufficient coverage。

它们不能都变成 `false`。Harvey 的合同 benchmark 也指出模型常越过材料“四角”补出合理却不可确认的内容。严格模式下，Claim 必须携带 review scope，才能说“在所审查的 10 份合同中未发现”。

## 3. Evidence 与 Claim 的关系是多值的

```ts
type EvidenceRelationKind =
  | 'supports'
  | 'refutes'
  | 'qualifies'
  | 'contextualizes'
  | 'defines'
  | 'derived-input'

interface EvidenceRelation {
  id: string
  claimVersionId: string
  evidenceId: string
  kind: EvidenceRelationKind
  rationale?: string
  coverage: 'full' | 'partial'
  createdBy: ActorRef
  reviewStatus: 'machine-proposed' | 'human-confirmed' | 'human-rejected'
}
```

同一 evidence 可以支持多个 claims；同一 claim 可以同时有 supports、refutes 和 qualifies。多个来源冲突时状态是 `contested`，不是按多数票自动选“真”。

### 3.1 Corroboration 不是重复 citation

如果三个网页都抄自同一新闻稿，它们不是三个独立证据。Evidence provenance 应记录 upstream source/derived-from；corroboration 只统计独立 lineage。类似地，一份模型摘要和它的原 PDF 不能算两票。

### 3.2 Assumption、Decision 与 Evidence 分开

专业工作允许“假设税率为 20%”“本次按管理层口径”“团队决定采用保守情景”，但这些不是原文事实。

```ts
type ClaimBasis =
  | 'document-supported'
  | 'derived-from-claims'
  | 'user-assumption'
  | 'project-decision'
  | 'external-knowledge'
```

Artifact 可以使用 assumption/decision，但必须在 manifest 中单列，并显示 actor、有效范围和来源。Personal
Memory 可以帮助恢复用户常用工作方式，却不能自动升级成 assumption；每个实际分析仍要显式采用。这样
既允许 scenario modeling，又不会把“用户偏好保守估计”误写成“报告证明为保守情景”。

## 4. Derived Claim 必须记录计算和推导

很多有价值的结论不在任何一句原文中，例如同比增长、跨合同差异、风险判断。

```ts
interface DerivationActivity {
  id: string
  operation: 'extract' | 'normalize' | 'calculate' | 'compare' |
             'aggregate' | 'infer' | 'human-edit' | 'verify'
  inputEvidenceIds: string[]
  inputClaimVersionIds: string[]
  outputClaimVersionIds: string[]
  expression?: string              // formula / rule / query
  tool?: { name: string; version: string; configHash: string }
  model?: { provider: string; model: string; promptHash: string }
  actor: ActorRef
  startedAt: string
  completedAt: string
  dsh?: { sessionId: string; turn: number; step: number; callId?: string }
}
```

[W3C PROV](https://www.w3.org/TR/prov-overview/)用 Entity、Activity、Agent 表达生成、使用、归属、派生、revision 和 invalidation。DocAtlas 可以用普通 JSON/SQLite 实现同样语义，无需一开始引入 RDF/图数据库。

计算型 Claim 的 verifier 要检查：输入 claim 当前有效、单位兼容、公式可复算、rounding 明确。模型推理型 Claim 则要显示“inference”而不是“quote”。

## 5. Claim 生命周期

```text
             machine/user creates
                     │
                     ▼
                 proposed
                 /   |   \
       evidence /    |    \ insufficient
               ▼     ▼     ▼
          supported contested unresolved
               │       │
       human review    resolve/add evidence
               ▼       ▼
       accepted/return supported/contradicted
               │
        source revision / edit
               ▼
          superseded or stale-dependent
```

规则：

1. Claim edit 永远创建新 version；旧版 lifecycle 变成 `superseded`，不原地改掉被旧 artifact 引用的文字。
2. Source revision 不自动迁移 selectors；先标 dependent claims stale，再 re-anchor/re-verify。
3. Human `accepted` 不表示宇宙真理，只表示人审接受当时显示的 epistemic status、scope 与 evidence。
4. `contradicted` 保留历史，不能物理删除成“从未发生”。
5. Published artifact pin 具体 ClaimVersion 和 EvidenceAtom；后续变化显示 update available。
6. 一个 chain 最多一个 current version，但独立相反 claims 可以同时存在并以 conflict edge 相连。

## 6. Answer 也应被拆成 Claim Uses

[ALCE](https://arxiv.org/abs/2305.14627)区分 answer correctness、citation recall/completeness 与 citation precision。DocAtlas 的最终产物不能只保存整段 Markdown：

```ts
interface ArtifactManifest {
  id: string
  version: number
  kind: 'answer' | 'brief' | 'matrix' | 'timeline' | 'slide' | 'audio-script'
  sections: ArtifactSection[]
  sourceScopeVersion: string
  personalizationUseIds: string[]
  verificationSummary: VerificationSummary
}

interface ArtifactSection {
  id: string
  markdown: string
  claimUses: Array<{
    claimVersionId: string
    start: number
    end: number
    visibleCitationIds: string[]
  }>
}
```

这样才能计算：

- **claim atomicity**：一个 span 是否塞了多个独立主张；
- **citation completeness**：每个 factual claim 是否有足够 support；
- **citation precision**：citation 是否真的支持对应 claim；
- **answer coverage**：是否覆盖用户问题要求的方面；
- **contradiction disclosure**：存在 materially conflicting evidence 时是否说明；
- **freshness**：artifact 是否仍引用 current source/claim version。

## 7. 两种回答模式

### 7.1 Explore Answer

目标是速度和对话流：

- 普通 DSH assistant message；
- inline citations 尽量绑定 Claim/Evidence；
- 可以存在 `proposed` claim；
- UI 明确标“exploratory”，不允许一键当成 human-accepted deliverable。

### 7.2 Published Evidence Brief

目标是可交付和可维护：

- Agent 调 `docatlas_publish_brief` 提交结构化 sections + claim ids；
- verifier 检查 selectors、support relations、conflicts、scope 和 derived claims；
- 缺口返回 Agent 修补，不能“引用格式正确就通过”；
- 满足 policy 后生成 versioned artifact；
- 可选 human sign-off；
- 工具可 `concludesTurn`，由自有 ToolView/Artifact View 显示主交付物，避免模型在验证后再自由改写一遍引入新事实。

这个双轨能同时保留聊天体验和专业可信度。

## 8. DocAtlas Journal 与 DSH Session Log 的关系

DSH Session log 仍是对话与 Agent 执行的真相：prompt、user/assistant、tool call/result、approval、cancel、steering。Claim/Evidence 是 DocAtlas 领域状态，需要独立 append-only journal，因为大量人类 UI 操作不一定经过模型工具。

```text
DSH Session Log                     DocAtlas Investigation Journal
----------------                    ------------------------------
user/message                         source.scope-changed
tool/call                            evidence.created
tool/result(meta: ids/hashes) <----> claim.proposed
approval/*                           claim.accepted/reworded/disputed
assistant/message                    artifact.published
user/message                         research-note/open-question/decision.created
turn/end                             memory.candidate-confirmed
```

每个两边都有 cross reference。推荐写入顺序：

1. DocAtlas artifact/blob/DB 事务先 durable；
2. tool 返回 ids + hashes，DSH 再持久化 `tool/result`；
3. crash 产生的 orphan domain records 可按未被 journal/session 引用回收；
4. DSH 有 result 但 domain record 缺失属于 integrity error，不伪造空 evidence。

现阶段不要写 DSH 不认识的 custom Session Event；Investigation Journal 自己有 schema version、migration 和 audit。

Research Memory 不需要再复制一份事实库。它应是 Investigation Journal 中 current/superseded Claim、typed
ResearchNote、Decision、OpenQuestion、Artifact 和 source links 的可查询投影。召回只返回 bounded lead；
真正用于事实回答时重新解析原 EvidenceAtom locator，并在 source scope 变化时记录新的 scope version。

## 9. Agent Loop：七阶段，而不是一次 Prompt

```text
0 Scope       定义问题、sources、严格度、预算、输出形态
1 Plan        分解问题、选择 tree branches / documents / subagents
2 Observe     Search/Read，产生 EvidenceAtoms，不直接写“事实”
3 Claim       把观察拆成 atomic claims，连接 supporting/refuting evidence
4 Challenge   找反例、缺失范围、版本差异、口径/时间冲突
5 Synthesize  选择符合 epistemic/review policy 的 claims，组织 answer/artifact
6 Publish     运行 verification gates，可选 human sign-off
7 Learn       从确认、纠正和结果生成 personalization candidates
```

这不是强制每个简单问题跑七个昂贵阶段。Policy 根据风险切换：

| Mode | 适用 | 必需阶段 |
|---|---|---|
| Quick | “p.3 讲什么” | Scope(light) → Observe → Answer |
| Grounded | 默认跨页问答 | Scope → Plan → Observe → Claim → Synthesize |
| Verify | 合同、财务、研究结论 | 全部；Challenge 与 publish gate 必须执行 |
| Compare | 多文档/多 revision | Scope → parallel Observe → Claim matrix → Challenge → Publish |

## 10. 如何使用 DSH 的 Agent 特性

### 10.1 Steering 是运行中编辑计划，不是再排一个普通问题

DSH `agent.steer()` 在 running driver 的下一个 step boundary 被消费。DocAtlas UI 可以把这些操作编码成结构化 steering：

- “只看 2024 report，排除 draft”；
- “先核验 p.17 表格，不要继续总结”；
- “这个 claim 太宽，请拆开”；
- “搜索反例，不要只找支持材料”；
- “预算减半，先返回 open questions”。

`followup()` 是下一 turn，适合新问题；`inject()` 是无唤醒的下一 step context，适合一次性的用户 selection。不要把三者混成同一个“发送”按钮。

### 10.2 Structured pending interaction

DSH `ask_user_question` 会阻塞 root Agent 的当前 tool call，支持 stable question id、options、multi-select 和 custom answer；当前还有 `plan-review` intent。DocAtlas 可增加自己的 pending interaction presentation：

- `source-scope-review`：选择允许使用的 sources；
- `claim-conflict-review`：展示相反 claims + evidence；
- `publication-review`：展示 coverage gaps 和 approve/return；
- `memory-candidate-review`：确认 scope 与保存内容。

只有 root Agent 能询问用户；runtime-owned child Agent 会被拒绝。因此 parallel subagents 必须把 `OpenQuestion[]` 返回 orchestrator，由 root 合并后一次向用户询问，避免多个弹窗争抢。

### 10.3 Approval 与 domain review 不相同

- DSH approval：是否允许执行有副作用的动作，如联网导入、写 memory、发布/导出、覆盖外部文件；
- Claim review：用户是否认可某个专业判断；
- Source selection：本 investigation 允许哪些材料；
- Memory confirmation：是否跨 session 保存偏好。

它们可以共享 UI 风格，但 audit event 和语义必须分开。

### 10.4 Turn-stopping 只做有界不变量门

`agent/turn-stopping` 可以在模型准备停止时用 `agent.steer()` 追加一步。DocAtlas 只应用确定性、有限次数的 gate，例如：

- Verify mode 仍有 published artifact 中的 unresolved claim；
- 用户要求反例搜索但 `challengePerformed=false`；
- final artifact 没有绑定 source scope version。

不要在这里启动无限 LLM critic loop。每个 gate 有 attempt limit，失败后把缺口交给用户。

### 10.5 Tool result 是 Evidence transport，不是大对象仓库

`docatlas_read` 的 result content 给模型必要 excerpt，meta 给 UI ids/locators/hash；page image 和完整 Markdown 放 artifact store。`docatlas_record`/`verify` 返回 ClaimPatch 与状态变化。所有 payload 有字符/数量预算和 truncation cursor。

### 10.6 Cancel、resume 与 unknown outcome

DSH 明确区分：未记录开始的 tool、已记录 call 但无 result 的 unknown outcome。DocAtlas read/search 可安全重试；publish、source sync、external export 先按 idempotency key 查外部/domain state，不能盲重试。

## 11. 用户可以直接操作什么

### 11.1 Source 操作

| 操作 | 结果 | Agent 影响 |
|---|---|---|
| include/exclude source | 新 `sourceScopeVersion` | 下一 step steering，旧 artifact 保持旧 scope |
| pin revision | 固定本调查使用的版本 | 禁止静默切到 live update |
| accept new revision | 创建 revalidation job | 标 stale claims，Agent 处理 delta |
| mark source authority | project policy，不是 truth | rerank/verification reason 可见 |
| open/crop/quote | 创建 EvidenceAtom | 可直接附给下一条问题 |

### 11.2 Evidence 操作

- 保存 excerpt / table cell / figure；
- 修正 OCR 或 table selection，形成新的 representation，不改原始 bytes；
- 标记“该证据不支持此 claim”；
- 添加 context（前后段、表头、脚注）；
- 请求 Agent 找 corroboration/counterevidence；
- 查看 provenance activity 与 parser/model version。

### 11.3 Claim 操作

- accept、reword（新 version）、split、merge；
- attach/detach evidence；
- mark unknown / disputed / out-of-scope；
- 设置 time、unit、jurisdiction、modality；
- request challenge；
- sign off / return for revision；
- 找出在哪些 artifacts 中被使用。

### 11.4 Agent/Plan 操作

- approve/reorder/skip subtask；
- set source scope、budget、strictness；
- pause/cancel/resume；
- steer focus；
- 查看 tool/activity trace 与未解决问题；
- 把一个 branch 分给 subagent，但 root 保持 human interaction owner。

### 11.5 Artifact 操作

- 选 section 让 Agent rewrite，但锁定 claim set；
- 添加/移除 claim 后自动刷新 coverage；
- Compare two versions；
- publish、sign off、export；
- 新 sources 到来时查看 impacted sections；
- 从 brief 生成 slide/audio 时 pin 同一 manifest。

### 11.6 Personalization 操作

- “以后默认先找反例”；
- “法律材料只做 four-corners review”；
- “数字必须 quote + table context”；
- 查看本轮 why-used；
- 本轮暂停某条 preference；
- confirm/edit/reject memory candidate。

Personalization Use 显示在 artifact metadata，但绝不作为 Claim Evidence。

## 12. UI：Fact Trace 不能藏在一个详情弹窗里

### 12.1 Claim Card

```text
┌─ Supported · Human reviewed ────────────────────────┐
│ 2024 operating margin was 18.2%.                    │
│                                                     │
│ Evidence 2 · Report 2024 p.31 · Table 4             │
│ Derived: operating income / revenue · reproducible  │
│ Used in: Q4 brief v3, comparison matrix             │
│ [Open source] [Challenge] [Edit] [History]           │
└─────────────────────────────────────────────────────┘
```

### 12.2 Evidence Inspector

同时显示：page image / quote / selector / representation type / extraction pipeline / relations / source revision。不是只显示 chunk 文本。

### 12.3 Contradiction Inbox

按 canonical claim key 聚合：

```text
Revenue guidance
  Report A (2024-02): 5–7%  supports c1
  Earnings call (2024-05): 3–5%  refutes/supersedes?
  Analyst note: ~4%  secondary interpretation

[Treat as update] [Different metric] [Keep contested] [Ask Agent]
```

系统不能替用户判断它是时间更新、口径变化还是矛盾。

### 12.4 Coverage View

展示用户问题的 subquestions × claim status：supported、unresolved、conflicted、not investigated。它比一个总置信分更可行动。

## 13. 个性化的唯一合法作用面

```text
可以影响：source ranking、tree Lens、阅读顺序、challenge 深度、解释层级、artifact 格式
不可影响：quote 内容、selector 解析、support/refute 判定、source revision、原始 claim history
```

用户偏好“相信公司年报”只能提高优先级或 source authority policy，不能让相反证据消失。个性化导致某 source/claim 被优先使用时，`MemoryUse` 必须进入 why-used。

## 14. Verification Gates

### G0 Integrity

- source revision 存在；
- selector 可解析且 hash 匹配；
- evidence/blob 未损坏；
- claim/artifact references 全部存在。

### G1 Grounding

- factual claim 至少一个 support relation；
- cited evidence 对 claim 有 full/partial coverage；
- model-generated description 不能作为唯一 primary evidence；
- derived claim 输入和公式完整。

### G2 Scope

- claim 没有越过用户指定 sources/four-corners boundary；
- absence claim 的 reviewed scope 足够；
- time/jurisdiction/unit 明确。

### G3 Conflict

- materially conflicting current claims 已披露或解决；
- superseded source 没被当 current；
- primary/derived circular support 被拒绝。

### G4 Publication

- 每个 artifact factual span 映射到 ClaimVersion；
- citation completeness/precision 过 policy；
- unresolved gaps 明示；
- 高风险模式有人类 sign-off。

## 15. 评测

| 指标 | 定义 |
|---|---|
| Atomic claim precision | 有充分 evidence support 的 current claims 占生成 claims 的比例；另报 human acceptance，不混成一项 |
| Claim coverage | 问题 gold aspects 被 supported claims 覆盖的比例 |
| Citation completeness | factual claim uses 有充分 evidence 的比例 |
| Citation precision | evidence relation 真正相关且非冗余噪声的比例 |
| Selector resolution | citation 在正确 revision 中可精确定位的比例 |
| Contradiction recall | gold conflict 被发现并呈现的比例 |
| Abstention / unknown accuracy | 缺材料时正确声明 unknown/not-found 的比例 |
| Derivation reproducibility | calculation/aggregation 可按记录重算的比例 |
| Human correction propagation | claim edit 后受影响 artifact/memory 是否正确更新 |
| Memory non-interference | personalization 开启后 grounding 结果是否保持不变 |
| Intervention utility | steering/review 操作减少的重跑、错误和时间 |

[RAGTruth](https://arxiv.org/abs/2401.00396)提醒：即使有 reference，span-level hallucination detection 仍很难。Verifier 不能只依赖另一个 LLM；要组合 deterministic integrity、schema/rule、retrieval coverage、NLI/LLM rubric 和 human review。

## 16. 必须保持的系统不变量

1. 原始 SourceRevision immutable；任何更新产生新 revision。
2. Evidence selector 永远绑定 representation + revision。
3. Claim edit 产生新 version，published artifact 继续指旧 version。
4. Derived artifact 不能作为祖先 claim 的独立支持证据。
5. Personalization 不进入 evidence support graph。
6. `not found` 不自动转为 negative claim。
7. 每个 factual artifact span 至少映射一个 claim；strict mode 不允许 unmapped prose。
8. 人类 review 的 actor/time/scope 可审计；不能只存最终值。
9. Child agents 不能绕过 root 的 source、approval 和 human-interaction boundary。
10. Background agent 不能静默改 published artifact；只生成 candidate update。
11. 删除/权限撤回立即阻止访问；历史 artifact 显示 source unavailable，不替换成同名文件。
12. 所有自动 verifier 都允许 `unresolved`，不能被迫二选一。
