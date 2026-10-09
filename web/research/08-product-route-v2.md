# DocAtlas 产品路线 v2：Evidence-native Personal Research Agent

> 调研日期：2026-08-29  
> 这是基于商业产品、DocAtlas 现有核心与 DSH Agent Loop 的产品判断，不是已实现规格。
> 七个产品面的完整交互、逐句/逐 Claim citation、多文档组织与业务模板见
> [Web UI 全景设计](16-web-ui-interaction-design.md)。

## 1. 一句话定位

> **DocAtlas 是一个 evidence-native 的个人研究 Agent：它和用户共同阅读长文档，把原文证据变成可追踪、可挑战、可复用的研究资产；新文档可以继续过去有证据链的工作，再按用户习惯产出可信的比较、brief 和交付物。**

三个词缺一不可：

- **Evidence-native**：不是回答末尾补 citation，而是所有重要结论从诞生起就绑定 source revision、selector 和 derivation。
- **Personal**：逐步学习用户的阅读顺序、证据标准、熟悉度和表达偏好，但这些偏好不改写事实。
- **Agent**：不是静态 RAG 搜索框；它能规划、读图表、跨文档比较、找反例、维护工作状态，并允许用户在运行中 steering、复核和签核。

## 2. 不是什么

- 不是另一个通用 PDF chat；
- 不是 NotebookLM 的本地克隆；
- 不是 PageIndex 上再包一层聊天；
- 不是把 TUI 放进浏览器；
- 不是自动积累一堆“AI 记忆”；
- 不是知识图谱可视化 demo；
- 不是最终答案加几个页码就宣称 verified。

## 3. DocAtlas 现有核心应该如何演化

当前核心的价值很明确：

| 现有能力 | 保留的本质 | v2 演化 |
|---|---|---|
| PageIndex tree Search | reasoning-based navigation | Navigator + query/personalized Lens；canonical tree 不被 finding 污染 |
| selective Read | text/page image/figure 独立读取 | EvidenceAtom producer，保留 representation 与 selector |
| Note | 人的意图、局部理解和 investigation checkpoint | 低摩擦 typed capture；按动作创建 Note/Question/Decision/Claim，不用一个自由文本容器包办 |
| Review | query-focused recall 与阶段性整理的原型 | Recall 与真正 Review 分离；Review 负责 coverage/challenge/decision/sign-off |
| post-Note tree annotation | 已读信息影响后续搜索 | derived overlay/index，不写进 canonical document structure |
| persisted session | 可恢复调查 | DSH Session Log + DocAtlas Investigation Journal 双日志 |
| TUI overview | Summary/Findings/Outline/History | Evidence Desk + Claim Ledger + Activity/Trajectory |

新的核心 primitive：

```text
DocumentRevision
SourceRepresentation
StructureNode
EvidenceAtom
ClaimVersion
EvidenceRelation
DerivationActivity
Investigation
ArtifactManifest
ResearchNote
OpenQuestion
ProjectDecision
PersonalizationMemory
```

这些 primitive 都属于 DocAtlas 的领域核心；DSH 提供 Agent Loop、Session signals、模型执行与 Web shell，
不拥有 PersonalizationMemory 的 taxonomy、lifecycle 或 recall policy。DocAtlas 原生能力与物理进程的区别
见[原生个性化架构提案](10-docatlas-native-personalization.md)。

Note、Review、Memory 是正交产品能力，不要求按旧 Skill 名称定义未来 contract。组合矩阵、现实场景和
record/recall/verify tool 备选见
[Note、Review、Memory 设计空间](15-note-review-memory-design-space.md)。

## 4. 七个产品面

### 4.1 Library：资料边界

负责：

- 导入、发现、同步、版本和权限；
- collection/notebook/project；
- source role：primary、external、user-note、model-derived；
- content hash 与 revision；
- 处理状态和 provider capability；
- source candidate → 用户/策略确认 → active scope。

Library 不是文件管理器皮肤。它决定 Agent 能看什么、哪个版本、是否允许联网、哪些 derived artifacts 不得自证。

### 4.2 Evidence Desk：共同阅读

在现有三栏设计基础上强化交互：

```text
Atlas / source scope     Original source          Investigation
documents + tree        PDF/Markdown/figure      plan + live agent cursor
Lens + coverage          selection + highlights  evidence + open questions
```

核心不是“显示 PDF”，而是 user cursor 与 agent cursor 并存：Agent 到 p.42 时不抢走用户正在看的 p.17；用户可一键 follow、pause、steer 或把选区附给下一 step。

### 4.3 Claim Ledger：事实工作台

这是 DocAtlas 相比 NotebookLM/Acrobat 的核心差异：

- atomic claims；
- support/refute/qualify relations；
- 正交的 epistemic/review/lifecycle 状态与 version history；
- contradiction inbox；
- query coverage map；
- calculation/derivation trace；
- 人工 accept/edit/split/merge/sign-off；
- claim → source、claim → artifact、claim → memory use 双向导航。

Ledger 可以有多种 view：cards、matrix、timeline、entity、risk、source-by-source；它们共享同一数据。

### 4.4 Evidence Studio：从事实到产物

Studio 不直接从 raw source 反复生成每种媒体，而从 pinned ClaimVersions 编译：

```text
Verified Brief
Comparison Matrix
Timeline
Review Memo
Slide Deck
Audio Script / Audio Overview
Study Guide / Quiz
```

每个 ArtifactManifest 记录 source scope、claim uses、个性化和 verifier summary。用户局部修改 section 时：

- 只改表达：保持 claim set；
- 改了事实：必须创建/选择新 ClaimVersion；
- 删除 citation：coverage gate 立即变红；
- 新 revision 到来：显示 impacted sections，不自动重写 published artifact。

第一阶段只做 Brief 与 Matrix，audio/slide 后置。

### 4.5 Personalization Center：用户适配控制面

这里只管理 Personalization Memory：

1. personal preference：写法、阅读方式和 evidence presentation；
2. familiarity：在不同 domain 中的术语与解释深度；
3. workflow preference：通常的 source order、challenge depth 和 artifact 形式；
4. preference candidate/probe：为何建议、来自哪些选择或纠正、是否接受。

Document claim 不进入个人 memory。Personalization Center 提供 candidate inbox、active topics、why-used、
scope、version、provenance、pause/forget/export。project/matter 的硬要求属于 ResearchPolicy/Workspace
Settings，也不应伪装成个人偏好。

### 4.6 Research Notebook：跨文档研究记忆

Research Notebook 管理用户已经完成的有证据研究，而不是“用户是什么样的人”：

- EvidenceBookmark、ClaimVersion 和 contradiction；
- ResearchNote 与 synthesis commentary；
- ProjectDecision、assumption 和 ResearchPolicy；
- OpenQuestion、coverage gap 和 next task；
- Comparison、Artifact 和 source-revision impact；
- Related prior work 与 `recall → re-resolve → reverify` 状态。

关闭 personalization 不影响 Research Notebook。旧 Note/Claim 只能作为 recall lead；进入新回答前必须
重新解析其 source revision/locator，并在超出当前 source scope 时让用户显式加入。完整设计见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

### 4.7 Review Workspace：从检查到裁决

Review Workspace 不是旧 Review Skill 的 Note recall 页面，而是呈现 deterministic checks、Agent challenge、
human decision 和 publication gate 的工作区。它按 issue/claim/checklist 展示 checked scope、missing evidence、
conflict、proposed patch、waiver 和 sign-off，并能双向回到 Claim Ledger 与原文。

Brief/Matrix 的最终 artifact 仍由 Evidence Studio 编译；Review Workspace 决定哪些 ClaimVersion 可以进入
它们。完整 tool/workflow 分离见
[Note、Review、Memory 设计空间](15-note-review-memory-design-space.md)。

## 5. 三种工作模式

### 5.1 Explore

用户需求：快速理解、追问、漫游。

- source-grounded chat；
- tree/node/selection 操作；
- exploratory citations；
- Agent 可快速 Search/Read；
- claim 可以是 proposed；
- 不强制挑战或 sign-off。

体验应接近 NotebookLM 的轻松，但保留 DocAtlas reader 和 evidence cursor。

### 5.2 Verify

用户需求：重要数字、合同、研究结论、跨文档差异。

- 明确 Investigation Brief、scope 和 strictness；
- Agent 必须拆 claims；
- 查 supporting 与 counterevidence；
- 显示 coverage、unknown、conflict；
- 计算可复算；
- 用户在 Claim/Matrix 层复核；
- personalization 只调策略，不改 verification。

体验接近 Harvey/Hebbia 的专业 review，但仍能回到原文深读。

### 5.3 Publish

用户需求：生成可发给同事、客户或写进决策的产物。

- pin source scope 与 revisions；
- 只使用符合 policy 的 claim versions；
- citation completeness/precision gate；
- unresolved/contested 必须披露；
- optional human sign-off；
- versioned artifact；
- 后续 source change 提示 update，不静默改稿。

Publish 是一个明确动作，不把每条 chat answer 都伪装成正式报告。

## 6. 八个关键用户旅程

### 6.1 “这份年报的主要风险是什么？”

1. 用户添加 report；
2. Agent 展开 canonical tree，建立风险 Lens；
3. Search → Read targeted sections；
4. Evidence Desk 显示 agent cursor；
5. Agent 建议 claims 与 citations；
6. 用户点击一个 claim，看原页、上下文和 derivation；
7. Explore answer 完成。

### 6.2 “比较 2023/2024 风险变化”

1. source scope 选择两个 revision；
2. Agent 提出 comparison plan；
3. 并行读取相应 sections；
4. Claim Matrix 行是风险主题，列是年度；
5. 系统区分新增、删除、措辞变化和真实立场变化；
6. 用户纠正一项口径；
7. 生成 versioned comparison brief。

### 6.3 合同 four-corners review

1. 用户切 Verify + four-corners；
2. 外部 Web/knowledge 禁用；
3. absence claim 显示实际 review coverage；
4. 被引用但未提供的 master agreement 标 unknown；
5. conditional columns 检查 jurisdiction-specific rules；
6. 用户 flag/comment/sign-off；
7. Published memo pin 合同 revisions。

### 6.4 用户运行中纠偏

1. Agent 正在读取 20 份材料；
2. 用户看到计划偏离，点击“只看原始 filings，排除 analyst notes”；
3. 生成新的 sourceScopeVersion，steer 进入下一 step；
4. 已生成但依赖排除 source 的 proposed claims 标 out-of-scope；
5. Agent 继续，不重启整场调查。

### 6.5 事实冲突

1. 两份 source 给出不同 forecast；
2. 系统发现 canonical key 相同但 time/value 不同；
3. Contradiction Inbox 展示 evidence；
4. 用户选择“五月更新取代二月 guidance”或“不同指标”；
5. 生成 claim revision/qualification，不删除旧历史。

### 6.6 越用越懂

1. 用户连续三次要求关键数字同时显示 table context；
2. 系统生成 candidate，而非静默保存；
3. 用户确认 workspace/global scope；
4. 后续 Agent plan 自动加入 table verification；
5. output 显示 why-used；
6. claim support 仍按相同 verifier，不因偏好放宽。

### 6.7 继续过去有证据链的研究

1. 用户打开新的季度报告并询问现金流变化；
2. Research Memory 找到上季度已核验 Claim、相关 Note 和一个未解决口径问题；
3. UI 显示 Related prior work，不把它混进 Sources 或 Personalization；
4. 用户确认把旧报告加入本次 source scope；
5. Agent 重新打开旧 Evidence 与新报告原表，检查 revision、时间和口径；
6. 系统生成 continuing/changed/contradicted/unknown 状态与 ContinuityLink；
7. 新 answer 精确区分本期证据、历史证据和用户旧 commentary。

### 6.8 从 Brief 到 Slide

1. 用户发布 verified brief；
2. Studio 选择受众和风格；
3. slide 只使用 brief manifest 的 claims；
4. 每页 notes 保留 claim links；
5. 用户修改数字时必须选择新 claim/evidence；
6. brief 与 slide 都显示 consistency 状态。

## 7. Agent Loop 的产品化

### 7.1 用户看到什么

不要显示隐藏 chain-of-thought；显示可验证的工作状态：

- current goal / subtask；
- 正在使用的 source scope；
- Search/Read/Verify/Compare 等 action；
- Agent cursor；
- collected evidence count；
- proposed/supported/conflicted claim count；
- open question；
- budget/time；
- why it paused；
- result/unknown/error。

### 7.2 用户何时介入

不是每一步都审批。只在以下 checkpoint：

- source/permission boundary 变化；
- 目标或口径含糊且会显著改变路线；
- 高成本 research plan；
- materially conflicting claims；
- 写入长期 memory；
- Publish/sign-off；
- external side effect。

其余通过轻量 steering：点击 source/tree/claim 即可调整下一 step。

### 7.3 Subagents

适合并行：每份文档、每个 question branch、support 与 counterevidence。每个 child 返回：

```ts
interface SubtaskResult {
  taskId: string
  evidenceRefs: string[]
  claimPatches: ClaimPatch[]
  openQuestions: OpenQuestion[]
  coverage: CoverageSummary
}
```

不返回无来源的长 prose summary。Root Agent 是唯一人机交互 owner 和最终 publish owner。

## 8. 两类长期 Memory 如何形成真正 moat

### 8.1 Personalization Memory：学习用户怎样研究

这里的个性化不是接入一个 DSH 通用 memory 后端，而是优化 DocAtlas 本身，形成与 Evidence、Claim、
Investigation 并列但严格隔离的 Personalization Kernel。DSH event 是 observation 来源，DSH Loop 是执行者；
用户研究方式的长期模型和治理记录由 DocAtlas 持有。

通用产品容易记住 tone 或 nickname；DocAtlas 应学习 **epistemic workflow**：

- 用户认为什么是足够证据；
- 哪类 source 更值得先看；
- 何时必须找反例；
- 喜欢 quote、table、visual 还是 summary；
- 哪些术语无需解释；
- 哪些风险/指标长期关注；
- 何时需要 Verify/Publish；
- 哪些失败路径在某类文档中应避免。

这些 memory 直接改善 Agent plan，因此比单纯改写回答更有价值。但使用必须可见，scope 必须严格，且 verifier invariant 不受影响。

### 8.2 学习信号优先级

```text
明确设置/remember
  > 用户对 claim/evidence 的结构化纠正
  > artifact 局部修订并成功 publish
  > 重复 steering / source choice
  > passive click/scroll（只做弱信号）
  > Agent 自己的推断（永远只是 candidate）
```

Harvey 的做法“从 edits/corrections 学习、使用时像 source 一样引用 memory”值得借鉴；DocAtlas 再加 scope/time/version 和 non-interference test。

### 8.3 Preference Probe：让用户主动校准界面

系统可以在合适时机展示两个受控版本，询问哪一个更适合理解或核验。它们必须由同一 canonical
Claim/Evidence/uncertainty backbone 渲染，只改变一个变量，例如 conclusion-first/evidence-first、简洁/
教学式、quote 折叠/展开或 prose/table。一次选择默认只形成 observation；用户显式选择 scope 后才成为
设置。这样学到的是可解释的 preference，而不是从停留时间猜测人格。

### 8.4 Research Memory：让研究工作产生复利

Research Memory 不属于 Personalization Kernel。它保存 Evidence-linked Claim、ResearchNote、Decision、
OpenQuestion、Comparison 和 Artifact，使新文档可以继续旧 investigation、发现变化并复核旧结论。它的
moat 来自逐步积累的 provenance-bound research state，而不是聊天条数。

旧对象只作为 `ResearchRecallLead`；必须 re-resolve/reverify 后才能支持当前回答。关闭个性化不关闭
Research Memory，关闭 cross-document continuity 也不删除用户偏好。两条路线的详细 contract 与场景见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

## 9. 竞争差异

| 维度 | 通用 Notebook/Project | 专业 Matrix/Legal AI | DocAtlas 目标 |
|---|---|---|---|
| Grounding | answer citation | cell/sentence citation | claim-level support graph + precise selector |
| Reader | source viewer | 常偏 review table | 原文深读 + Agent/user 双 cursor |
| Agent | research/generation | workflow/parallel agents | DSH 可 steering、可暂停、可回放 Agent Loop |
| Fact state | 多在答案内 | 部分 table/flags | versioned Claim Ledger |
| Research continuity | chat/note history | matter/playbook reuse | evidence-linked Research Memory + recall-to-reverify |
| Human role | 提问、反馈、改 artifact | review/sign-off | 阅读、选证、改 claim、处理冲突、签核 |
| Personalization | instructions/memory | playbook/style | epistemic workflow memory + why-used |
| Artifact | 每类重新生成 | memo/deck/model | one claim manifest → many consistent views |
| Update | source sync/重新生成 | workflow rerun | impact analysis + stale claims + selective revalidation |

## 10. 建议首发产品切片

不要一开始做大而全 Studio。首发应完整证明一条闭环：

> **两份长 PDF → Agent 计划/阅读 → 用户运行中纠偏 → Claim Matrix → 点击回精确原文 → 处理一个冲突 → 发布带完整事实追踪的 comparison brief → 保存一条证据偏好和一个 OpenQuestion → 下一次 investigation 召回并重新核验。**

它同时验证：

- PageIndex/DocAtlas navigation；
- PDF/Markdown/figure reader；
- DSH Agent Loop 与 steering；
- Evidence/Claim 数据模型；
- multi-document identity；
- human review；
- artifact manifest；
- Research Memory 的 bounded recall-to-reverify；
- personalization why-used。

比“单 PDF 问答 + 漂亮三栏 UI”更能证明产品价值。

## 11. 明确延后

- Audio/Video Overview；
- 自由知识图谱画布；
- 自动团队 memory；
- 百万文档虚拟 tree；
- always-on background agent；
- 复杂 ontology；
- 自动修改 published artifact；
- 声称法律/财务结论“已证实”；
- 任意 derived note 自动升级为 source；
- 一开始支持所有商业 provider。

## 12. 北极星指标

一个单纯 answer satisfaction 指标会鼓励流畅幻觉。建议组合：

```text
Trustworthy Work Completed
  = published/reused artifacts
    × claim coverage
    × citation/selector validity
    × human acceptance
    × later correction survival
    ÷ review time and inference cost
```

产品级观测：

- 用户点击 citation 后是否确认/纠正；
- proposed claims 被接受、编辑、拒绝的比例；
- conflict 被及时发现的比例；
- steering 后少走了多少无效读取；
- artifact update 是否只触及 impacted sections；
- memory use 是否减少重复 instruction，同时不降低 factual metrics；
- Related prior work 是否减少重复定位/核验，同时保持 source-scope precision；
- 新 revision 是否正确触发 stale Claim、OpenQuestion 和受影响 Artifact；
- published artifact 的 reuse 和 source-change survival。

## 13. 最终路线判断

DocAtlas 最强的组合不是：

```text
PageIndex + Chat UI + Memory
```

而是：

```text
DocAtlas multimodal evidence core
+ PageIndex-style reasoning navigation
+ DSH durable and steerable Agent Loop
+ Claim/Evidence provenance and human review
+ evidence-linked Research Memory and cross-document continuity
+ transparent epistemic personalization
+ evidence-compiled artifacts
```

这条路线比 NotebookLM 更适合需要核验和长期维护的专业研究，比纯 Matrix 产品更保留原文深读与开放式探索，也比通用 Agent 更清楚地区分“模型做过什么”“用户已经研究过什么”“用户通常怎样研究”和“材料真正支持什么”。
