# DocAtlas Web UI 全景设计

> 2026-09-08 执行规格：[DocAtlas 自有 Web](../docs/product/web-experience.md)。本页保留完整业务/交互调研；
> DSH slots、强制三栏与旧默认导航仅是历史方案。当前默认居中聊天，引用打开原始 PDF，重模块按需展开。

> 副标题：逐句出处、多文档工作区、selection 问答与真实业务交互
> 状态：Large-scale interaction research / product specification input，不是已实现 UI
> 调研与对齐日期：2026-08-30
> 关联：[完整实施主计划](../docs/implementation-plan.md)、
> [早期文档页面设计](04-document-experience.md)、[Fact Trace](07-fact-trace-agent-interaction.md)、
> [产品路线](08-product-route-v2.md)、[Memory 架构](14-adaptive-interface-research-continuity.md)

## 1. 结论先行

DocAtlas Web UI 最重要的产品承诺不是“在 Chat 旁边显示 PDF”，而是：

> **回答中的每一个 material factual claim 都能看见证据状态；点击 citation 后，立即进入正确文档、正确
> revision、正确物理页和对应原始段落/表格单元/图像区域，并能继续询问、比较、保存或挑战。**

围绕这条主线，UI 必须同时解决：

1. 当前回答和原文的双向跳转；
2. 大量文档如何分组、筛选、限定 source scope 和显示实际 grounding subset；
3. 用户选中文字、表格、图像或多个跨文档片段后直接问 Agent；
4. Agent 运行时怎样显示计划、进度、coverage、冲突并允许轻量 steering；
5. Note、Question、Claim、Review、Research Memory 和 Personalization 怎样回到原文而不混成一堆卡片；
6. 单文档精读、双版本 Compare、多文档 Matrix、时间线和 Publish 如何共享一套领域状态；
7. loading、partial、stale、permission denied、OCR mismatch、cancelled 等现实失败怎样诚实呈现；
8. 桌面、窄屏、键盘、触控、屏幕阅读器和大规模文档集怎样可用。

核心产品公式：

```text
DocAtlas Web Experience
  = Source-native Reader
  + Claim-level Answer Trace
  + Explicit Multi-document Scope
  + Direct Manipulation of Source Objects
  + Steerable Agent State
  + Research Continuity
```

## 2. 本轮调研结论

### 2.1 商业系统和主动阅读工具

| 系统 | 已复核交互 | 对 DocAtlas 的设计输入 |
|---|---|---|
| [Gemini Notebook chat](https://support.google.com/gemininotebook/answer/16179559?hl=en) | source checkbox、citation hover 完整 quote、click 自动到上下文、Save to Note、stop/revise | source scope 必须显式；citation preview 和跳转是一等交互 |
| [Adobe contract intelligence](https://news.adobe.com/news/2025/02/acrobat-ai-assistant-contracts) | scanned contract、key terms、clickable citation、最多十份合同比较、review/sign | 原文 viewer 与业务 workflow 不能割裂；document type 可触发模板 |
| [Copilot Notebook references](https://support.microsoft.com/en-us/microsoft-365-copilot/add-references-to-your-microsoft-365-copilot-notebook) | file/folder/site、搜索/上传/链接/拖放、权限继承、reference 更新、大 collection grounding limit | Library、eligible source 与 actual grounded subset 必须分开显示 |
| [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) | 右侧独立工作面、选中文字直接 Edit、版本切换、多文件 edit request、多个 artifact | selection 不应靠自然语言描述位置；artifact 要局部修订和版本化 |
| [Harvey Review Tables](https://www.harvey.ai/blog/collaborative-review-tables) | conditional columns、sentence citation、flag、comment、manual input、协作核验 | 多文档专业工作需要结构化中间态和 human checkpoint |
| [AlphaSense Deep Research](https://www.alpha-sense.com/resources/product-articles/introducing-deep-research-in-alphasense/) | plan、迭代 search、长运行 research、granular inline citations、click-through audit | 长任务需要可编辑 brief、background progress 和 granular audit |
| [AlphaSense monitoring](https://www.alpha-sense.com/blog/product/monitoring/) | watchlist、dashboard、alerts、highlighted statement、context 和 document link | 新文档/新 mention 应触发可控 monitoring 和 impact inbox |
| [Elicit](https://elicit.com/) | paper selection、screening、extraction table、sentence citation、可定制 report | 科研/批量任务不能只提供 chat；table/criteria 是一等对象 |
| [Zotero PDF Reader](https://www.zotero.org/support/pdf_reader) | text/area annotation、annotation 拖进 Note、citation、Show on Page、跨文档 Note | annotation → note → source round-trip 应无损保留 |
| [LiquidText](https://www.liquidtext.net/features) | 原文旁 workspace、跨页摘录连接、tap 回原文、多个区域联合评论 | 用户阅读中的连接与重构本身就是核心工作 |

这些产品证明 citation、source scope、selection、matrix 和 annotation 是强需求；它们没有自动解决
Claim lifecycle、跨 artifact 一致性、revision freshness 或 Personalization non-interference，后者仍是
DocAtlas 的差异化。

### 2.2 Citation 与可访问性标准

- [W3C Web Annotation](https://www.w3.org/TR/annotation-model/)建议 Specific Resource 绑定 source state，
  同一 segment 可使用 TextQuote、TextPosition、Fragment/SVG 等多个 selector，提高未来可解析性；position
  对内容变化脆弱，应与版本 state 配合。
- [WCAG 2.2 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
  要求 keyboard focus 不被 sticky header、composer 或 overlay 完全遮挡；citation jump 必须设置 scroll
  padding 并保持可见 focus。
- [WCAG 2.2 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)规定一般 pointer
  target 至少 24×24 CSS px 或有足够间距；重要 toolbar 和移动端 action 以 44px 为产品目标。
- [WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)要求搜索结果数、
  loading、保存成功、失败和 progress 等动态状态可被辅助技术识别，而不无故抢 focus。

### 2.3 当前 DSH Web seam 的可行性

固定 DSH source 已确认：

- `conversation.view` 支持 session-scoped additive View，并提供 `openView(view, opaqueFocus)` 与一次性
  `completeViewRequest()`；
- `conversation.chat.assistant-actions` 可以给每条 finalized assistant message 增加“查看来源”；
- `conversation.input.dock`、`conversation.composer.dock/input.left/input.right` 可承载 selection context tray；
- `conversation.session.header.actions/utilities` 可放 source scope、mode、export 等轻量控制；
- `ctx.connection.rpc` 和 strict Remote 支持认证、codec validation、stream 与 AbortSignal；
- `ctx.connection.fetch.register()` 支持 `/api/...` exact GET/HEAD route，可安全提供 PDF Range/page/asset；
- DSH Trajectory 已实现长列表 virtualization、tail follow suspension、record inspector 和 timing overview；
- message feedback 已提供 Host-owned compare-and-set/version-conflict 模式，可复用到 Note/comment/review edit。

因此首版不需要 DOM patch、裸 Web route 或替换 DSH Chat。DocAtlas 应注册一个主 `conversation.view`，
在内部组织多个工作面，并使用 opaque focus request 完成 chat citation → reader 的跳转。

## 3. 信息架构

### 3.1 用户心智模型

```text
Library                    我拥有哪些资料？
  └─ Workspace/Matter      这项长期工作属于什么边界？
      └─ Collection/Series 哪些文档是一组或同一系列？
          └─ Investigation 这次具体要回答什么？
              └─ SourceScopeVersion 本次允许/排除了哪些 source/revision？
                  └─ DocumentRevision 当前阅读的是哪一版？
                      └─ Representation PDF/text/OCR/table/figure
```

不能把 Session、Workspace、Collection、Document 和 Revision 都显示成一层“附件列表”。用户需要知道：

- 资料是否在 Library；
- 是否被纳入当前 investigation；
- 是否实际被 Agent 读取；
- 是否最终被回答引用；
- 是最新 revision 还是旧版；
- 是否有权限与处理能力。

### 3.2 DSH 一级导航与 DocAtlas 内部导航

DSH 保留顶层：

```text
[Chat] [DocAtlas] [Trajectory]
```

DocAtlas 内部按任务切换，不把七个产品面全部塞成 DSH tabs：

```text
DocAtlas
├─ Desk        默认共同阅读
├─ Notebook    Notes / Questions / Decisions / prior work
├─ Claims      Claim Ledger / Coverage / Contradictions
├─ Review      checklists / issues / diff / sign-off
├─ Studio      Brief / Matrix / Timeline / later artifacts
└─ Personalize preferences / probes / why-used

Library / Source Scope 作为全局 drawer/header control
```

### 3.3 默认桌面布局

```text
┌─ Workspace / Investigation ─ Source scope 5/12 ─ Mode: Verify ─ Agent status ─┐
├──────────────────┬────────────────────────────────────┬───────────────────────┤
│ Documents        │ Original Source                    │ Investigation          │
│ + Outline        │                                    │                       │
│                  │ PDF | Text | Compare               │ Question / Plan       │
│ ▾ 2026 Q2        │                                    │ Answer + citations    │
│   Summary        │ page canvas + text layer           │ Claims / Evidence     │
│   Cash flow  ●   │ bbox / quote / table highlight     │ Open questions        │
│ ▸ 2026 Q1        │                                    │ Related prior work    │
│                  │ user cursor ≠ agent cursor          │ Why personalized      │
├──────────────────┴────────────────────────────────────┴───────────────────────┤
│ [selected: Q2 p.17 ¶3] [Q1 p.12 Table 4]       DSH resident composer   Send │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Citation focus 布局

用户从 Chat 点击 source 后：

```text
Chat answer scroll position preserved
        │
        ▼
DocAtlas view opens
┌─ Source A / rev 2026-06 ─ p.17 ─ citation 2 of 3 ─ [Back to answer] ─┐
│ exact paragraph/table region highlighted                            │
│                                                                    │
│ [Why this supports the claim] [Open Evidence] [Ask] [Challenge]    │
└────────────────────────────────────────────────────────────────────┘
```

跨文档 citation 默认切换 reader document，但保留来源 breadcrumb 和本地返回历史；用户 pin 当前 source 时，
新的 citation 在临时 compare pane 或 popover 中打开，不覆盖正在精读的位置。

### 3.5 Compare 与 Matrix

```text
Compare Lab
┌──────── 2025 contract · Clause 7 ────────┬──────── 2026 contract · Clause 7 ───────┐
│ old text + highlight                     │ new text + highlight                    │
├──────────────────────────────────────────┴─────────────────────────────────────────┤
│ Changed Claim / qualification / user decision / unresolved issue                  │
└────────────────────────────────────────────────────────────────────────────────────┘

Investigation Matrix
┌─ Question / Claim ─┬─ Doc A ─┬─ Doc B ─┬─ Doc C ─┬─ Coverage / Review ─┐
│ Notice period      │ 30 days │ 15 days │ unknown │ conflict            │
│ Governing law      │ NY      │ CA      │ —       │ complete            │
└────────────────────┴─────────┴─────────┴─────────┴─────────────────────┘
```

Compare 适合两个 source/revision 深读；Matrix 适合多个 source × 多个问题。两者使用相同 Claim/Evidence
对象，不能各自保存一套事实。

## 4. “每一句话有出处”的准确产品定义

### 4.1 从 sentence citation 升级到 claim-span trace

自然语言一句话可能包含多个独立事实。例如：

> 公司收入增长 12%，主要来自云业务，同时毛利率下降 2 个百分点。

这至少包含三个 Claim，可能来自三处证据。只在句尾放一个 citation 会制造虚假精确感。因此产品承诺应
实现为：

1. 每个 material factual **span** 映射一个或多个 ClaimVersion；
2. 每个 ClaimVersion 映射 support/refute/qualify Evidence；
3. 每个 sentence 都有 audit classification；
4. non-factual connective/advice 明确属于无需 source，而不是悄悄漏 citation；
5. strict Publish 不允许 unsupported factual span。

### 4.2 Answer 数据结构

避免跨语言 offset 和 Markdown AST 漂移，首版优先让结构化 segment 自身携带 text：

```ts
interface AnswerManifest {
  id: string
  sessionId: string
  turn: number
  sourceScopeVersion: string
  mode: 'explore' | 'verify' | 'publish'
  blocks: AnswerBlock[]
  verificationSummary: VerificationSummary
}

interface AnswerBlock {
  id: string
  kind: 'paragraph' | 'list' | 'table' | 'heading' | 'callout'
  segments: AnswerSegment[]
}

interface AnswerSegment {
  id: string
  text: string
  kind: 'factual' | 'derived' | 'interpretive' | 'procedural' | 'social'
  status: 'supported' | 'qualified' | 'contested' | 'unresolved' | 'not-applicable'
  claimVersionIds: string[]
  visibleCitationIds: string[]
}
```

如果后续需要保存 Markdown + offsets，wire 必须明确 offset 使用 UTF-8 byte、Unicode scalar 还是 UTF-16，
并同时保存 exact text/hash；不能让 Python 与 JavaScript 对 emoji/CJK 产生不同 span。

### 4.3 默认 citation 呈现

- factual span 使用克制的 underline/source marker，句末显示一个合并 citation group；
- hover 或 keyboard focus 显示 exact quote、document、revision/date、physical page、relation 和 status；
- click 直接跳原文；不先打开阻挡用户的中间 modal；
- `3 sources` group 展开 primary/corroborating/refuting/qualifying evidence；
- citation marker 的可见编号只属于当前 answer，底层使用稳定 opaque ID；
- Answer 顶部显示 coverage：例如 `8/8 factual claims mapped · 1 conflict disclosed`；
- Audit mode 可显示每个 sentence 的 classification 和 unsupported gap；
- Explore 中 provisional citation 使用不同状态，不伪装 human-reviewed；
- copied/exported answer 保留 footnote、document/revision/page 和 resolver link。

### 4.4 多 source 和冲突

同一 Claim 的 citation popover按关系分组：

```text
Supports (2)
  Annual report 2026 · p.17 · Table 4
  Earnings transcript · p.6

Qualifies (1)
  Accounting note · p.42 · different currency basis

Refutes (1)
  Auditor adjustment · p.3
```

存在 material conflict 时不能只把多个 citation 并排。Claim span 显示 contested 状态，点击优先进入
Evidence Inspector/Compare，而不是默认挑一个“赢家”。

### 4.5 Derived Claim

计算或推导型句子点击后显示：

```text
Result: 18.2%
Formula: operating income / revenue
Inputs:
  operating income → Doc A p.31 Table 4
  revenue          → Doc A p.31 Table 4
Rounding: one decimal
Recompute: passed
```

模型 interpretation 与 source quote 使用不同标签。不能把“模型观察图表后认为趋势加速”渲染成原文直接
陈述。

## 5. Citation 点击到原文的完整状态机

### 5.1 正常路径

```text
1 user activates citation
2 Chat calls openView('docatlas', opaqueFocusId)
3 DocAtlas acknowledges one-shot request and requests locator resolution
4 Host authenticates session/workspace/source permission
5 Resolver selects exact DocumentRevision and Representation
6 Client loads document metadata and required PDF range/page/text layer
7 State is processed before selectors
8 bbox/table/figure target is focused; TextQuote validates content
9 reader scrolls with sticky-header/composer padding and visible focus
10 citation history records answer ↔ source return path
```

### 5.2 Selector 优先与互校验

```text
revision/document state
→ physical page
→ table/figure/bbox/position target
→ exact quote + prefix/suffix/hash validation
→ fallback page pulse with explicit unresolved reason
```

多个 selector 应指向相同内容；若 bbox 与 quote 指向不同文本，状态是 `ambiguous`，不能静默选择一个。

### 5.3 Citation focus UI 状态

| 状态 | UI 行为 |
|---|---|
| resolving | marker pending，reader skeleton；保持 answer focus history |
| resolved | exact region highlight + accessible announcement |
| page-only | 定位页并提示“无法精确匹配段落” |
| stale | 显示旧/新 revision，允许打开旧版或发起 re-anchor |
| ambiguous | 显示候选区域，不自动认定其中之一 |
| missing-source | 显示 metadata/provenance，不伪造空页面 |
| permission-denied | 不泄漏 quote/filename；提供申请权限动作 |
| unsupported | 保留 answer gap，提供 Challenge/Find evidence |
| offline/reconnecting | 保留 focus request，可取消；重连后显式恢复 |

### 5.4 表格、图像与 OCR

- table citation 必须高亮 cell，同时保留 row/column headers 和单位；
- figure citation 高亮 crop/bbox，同时显示 caption 和 physical page；
- scanned/OCR citation 同时显示 page image region 与 extracted text；
- OCR mismatch 允许用户“纠正抽取”，创建新 representation，不改原始 image；
- page rotation/crop box 进入 bbox transform；不同 revision 不复用裸坐标；
- citation preview 使用 original excerpt，不从 answer 反向生成。

### 5.5 导航细节

- `[` / `]`：上一条/下一条 citation；
- `Shift+Enter`：在 compare pane 打开；
- `Esc`：关闭 preview/focus rail，不丢当前页；
- “Back to answer”恢复原 answer scroll 和 active span；
- source history 支持前进/后退，但不与浏览器路由历史无限重复；
- user pin source 时 Agent read/citation 不抢主 reader；
- hover preview 不在触屏上作为唯一入口。

## 6. 多文档组织

### 6.1 Library 不只是附件列表

每个 document card 至少显示：

```text
display name / type / provider
logical document + current revision
date/period/entity/tags
source role: primary / external / user-authored / model-derived
processing: queued / ready / partial / failed
capability: text / OCR / table / figure / page image
permissions / sharing
investigations, claims, notes, artifacts, last activity
```

支持 upload、drag/drop、folder/provider browse、URL、dedupe、replace-as-new-revision、archive。文件路径只在
Host 端解析，Client 永远使用 document/asset IDs。

### 6.2 四种组织方式

1. **Collection**：用户手工组织，例如“竞争对手材料”。
2. **Series**：同一 logical document 的时间/版本序列，例如 2024–2026 年报。
3. **Matter/Workspace**：有权限和 ResearchPolicy 的长期业务边界。
4. **Watchlist/Saved Query**：按公司、主题、条款或指标持续发现新材料。

Tag/collection 不是 source scope；加入 Library 也不等于本次允许 Agent 使用。

### 6.3 Source Scope Drawer

```text
Current Investigation Scope

Eligible  42     Included  12     Used  7     Cited  4

[✓] 2026 Q2 filing       primary   current revision
[✓] 2026 Q1 filing       primary   historical
[ ] Analyst note         secondary excluded by policy
[?] New auditor letter   candidate requires confirmation
[!] 2025 report          included but permission expired

[Lock scope] [Save preset] [Compare selected] [Show exclusions]
```

必须区分：

- eligible：权限/collection 允许；
- included：当前 `SourceScopeVersion` 纳入；
- used：Agent 实际检索或阅读；
- cited：最终 answer/artifact 使用；
- excluded：用户或 policy 排除；
- candidate：Agent/provider 发现但尚未纳入。

大量 folder/reference 被连接时，UI 不能暗示全部内容都参与 grounding。Copilot 当前公开的 reference 数量
限制说明，collection size 与 actual grounding set 本来就是不同概念。

### 6.4 多文档导航模式

| 模式 | 最适合的问题 | 主要结构 |
|---|---|---|
| Document Roots | 在多份材料间漫游 | document → outline tree |
| Compare | 两个版本/两份文档具体哪里不同 | aligned sections + dual source panes |
| Matrix | 多 source × 多问题 | rows/columns/cells + evidence |
| Timeline | 说法、指标、风险怎样变化 | date/revision/claim events |
| Coverage Map | 哪些问题在哪些 source 有/无证据 | question × source status |
| Entity/Topic Lens | 哪些材料谈到同一实体/主题 | derived grouped projection |
| Impact View | 新 revision 影响哪些旧 Claim/Artifact | dependency list + reverify actions |

### 6.5 版本与重复文件

- 同名不是同一 document；logical series 由用户/provider metadata 和 content identity共同确认；
- 新 bytes 创建新 revision，不覆盖旧 citation；
- exact duplicate 提示复用，不重复 ingest；
- near duplicate 可建议“作为新 revision/独立 document”；
- current revision badge 不隐藏旧版；
- Compare 对齐按 heading/block/quote/structure，不按裸页码同步滚动；
- source deleted/permission changed 后，旧 artifact 显示 missing/stale impact。

### 6.6 大规模 source 操作

- source list virtualized，filter/sort/search 不挂载全部 card；
- bulk include/exclude/tag/compare/archive；
- select all 只作用于当前 filtered set，并显示确切数量；
- scope 变更有 preview 和 version，不在 Agent 运行中静默替换；
- saved scope preset 可用于 recurring workflows；
- Watchlist/Alert 新结果先进入 candidate inbox，不自动改变 published work；
- Dashboard/monitoring 只显示新变化和 impacted objects，避免新文档数量本身成为通知噪声。

## 7. 选中文档内容直接问答

### 7.1 Selection 类型

```text
text range
table cell / row / column / rectangular region
figure / image region
whole page / heading section
multiple non-contiguous ranges
multiple selections across documents
existing annotation / evidence / claim / note / artifact section
```

每个 selection 都携带 document/revision/representation、selectors、exact preview/hash 和创建时间。Client
展示 preview，但 Host 保存完整 staged context。

### 7.2 Selection toolbar

```text
[问 Agent] [解释] [比较] [找反例] [保存摘录]
[写 Note] [提出问题] [形成 Claim] [加入 Brief] [复制引用]
```

动作根据类型变化：

- table selection 增加“保留表头/单位”“比较同列”；
- figure 增加“视觉解读”“打开 caption/source text”；
- multiple sources 增加“对齐差异”“生成 matrix row”；
- Claim/Evidence 增加“Challenge”“Attach/Reject evidence”；
- artifact section 增加“Edit with Agent”“重新核验”。

### 7.3 Context Tray

点击“问 Agent”不会立刻在一个孤立浮窗生成答案，而是将 selection 变成 DSH composer 上方的可见 chip：

```text
[Q2 p.17 ¶3 · 238 chars ×] [Q1 p.12 Table 4 ×]
[仅使用选区 □] [本问题后保留 □]
```

用户可以删除、排序、展开 preview、设置“只用这些”或“作为重点但允许补充 source”。多选过大时显示
document/page/char/estimated context 和将使用 progressive Read 的说明。

### 7.4 Atomic 提交协议

```text
Client selection
→ Host stageSelection(document/revision/selectors/hash)
→ returns opaque nonce + expiry + preview
→ composer chip references nonce
→ direct user message atomically consumes nonces
→ Agent pre-step receives validated SelectionContext
→ replay records stable locator IDs, not reusable nonce
```

nonce 过期、revision 变化、权限丢失或与 session 不匹配时拒绝提交并让用户重新选择；不能把旧 selection
静默附到另一条消息。

### 7.5 One-shot 与 pinned context

- 默认 selection 只用于下一条 direct message；
- “本问题后保留”把它加入 current investigation focus，不等于进入长期 Memory；
- “保存摘录”创建 EvidenceBookmark；
- “写 Note”创建 commentary/hypothesis；
- “形成 Claim”进入结构化 Claim flow；
- “加入 source scope”作用于 document/revision，不把一段 selection 当整份文档授权。

### 7.6 Inline quick answer 的边界

可以为“解释术语/翻译/计算”提供小型 inline answer，但必须：

- 仍由 DSH 执行并进入 Session/Trajectory；
- 标明 selection scope；
- 支持“继续到主对话”；
- 不创建第二套隐藏 chat history；
- factual result 仍能跳 source 或显示 calculation trace。

## 8. 主动阅读、Annotation 与 Note

### 8.1 Annotation 类型

- highlight/underline；
- text/area/ink annotation；
- comment/reply/mention；
- EvidenceBookmark；
- Question/Issue/Conflict flag；
- Claim linkage；
- Review status；
- private/team visibility（后期）。

颜色只能表示用户选择的类别，不能单独表达 supported/contested/stale。所有状态同时有文本、图标和
accessible label。

### 8.2 Annotation → Note → Source round-trip

借鉴 Zotero/LiquidText：

- annotation 可以拖入 Note/Research Notebook；
- Note 中保留 exact quote、document/revision/page 和 citation；
- 点击 Note excerpt 执行 Show on Page；
- 多文档 annotations 可以组合成一条 synthesis Note；
- 删除/旋转/新 revision 后不按裸页码继续定位；
- annotation 可隐藏 citation 的视觉显示，但底层 provenance 不能删除后假装仍可验证。

### 8.3 User 与 Agent 标注

- User annotation 表达人的注意和判断，Agent 不可静默修改；
- Agent suggestion 默认虚线/候选状态，支持 accept/edit/reject；
- accepted 不等于 Claim supported；
- Agent cursor 是 transient，不保存为 annotation；
- passive scroll/click 不是强 Personalization signal。

## 9. Agent 运行时交互

### 9.1 用户应该看到什么

```text
Goal / current subtask
SourceScopeVersion and current document
Action: searching / locating / reading / comparing / verifying / publishing
Agent cursor and coverage
Evidence/Claim/OpenQuestion counts
Plan changes and why
Elapsed time / budget / expected next checkpoint
Pause/cancel/error/resume state
```

不显示隐藏 chain-of-thought。可以显示可验证的 plan、选择 source 的 rationale、tool inputs/outputs、状态和
结果。

### 9.2 Steering

- 点击 document/node/page：把下一步引向该 source；
- 点击“只看 primary sources”：创建新 SourceScopeVersion；
- 对 Claim 点 Challenge：加入 counterevidence subtask；
- 对 plan step 点 Skip/Defer/Prioritize；
- Stop 后可 revise prompt 或 keep generating；
- steering 对下一 step 生效，已完成结果按新 scope 标 out-of-scope/stale，而不是删掉历史。

### 9.3 Approval/checkpoint

只在这些动作暂停：

- 扩大 source/permission/provider 边界；
- 高成本长运行计划；
- materially conflicting claims 需要裁决；
- 写入高影响 Personal Memory；
- Publish/sign-off/export；
- external side effect。

普通 Search/Read/annotation 不逐步弹 approval。

### 9.4 Background research

- 先显示可编辑 Investigation Brief；
- 运行后提供 compact progress + 可展开 trajectory；
- 用户离开 View 仍能在 DSH header/notification 看状态；
- completion 进入 inbox，不抢走用户当前 reader；
- cancellation 显示哪些 steps completed、unknown、safe-to-resume；
- 重新进入后从 durable projection 恢复，不靠 Client memory。

### 9.5 User cursor 与 Agent cursor

- Agent read 默认只点亮 tree 和右栏，不自动滚动主 reader；
- Follow on：新 locator 自动定位；用户手动滚动后自动 paused；
- Follow paused：显示“Agent 已到 p.42”按钮；
- Follow once：从 tool/claim/citation 只跳一次；
- background update 使用 status message，不抢 keyboard focus。

## 10. 七个产品面的交互清单

### 10.1 Library

需要：import、provider、collection/series/watchlist、revision、processing、permission、duplicate、search、
filter、bulk actions、scope presets、activity/impact badges。

关键空态：无文档、处理中、部分可用、provider offline、permission expired、duplicate detected。

### 10.2 Evidence Desk

需要：outline、PDF/text/compare、page navigation、selection、annotations、dual cursor、Agent progress、answer
citations、evidence inspector、related prior work、why personalized。

这是首版默认页面，也是逐句 citation 和 selection 问答的核心交付面。

### 10.3 Research Notebook

需要：Notes、Bookmarks、Questions、Decisions、Related prior work、collections/tags、Show on Page、convert to
Claim/Task、resolve/supersede、source and author filters。

不把所有内容叫 Memory；unverified/stale/missing-source 可见。

### 10.4 Claim Ledger

需要：Claim cards、support/refute/qualify、status、history、split/merge/reword、Attach/Reject Evidence、
Challenge、Coverage、Contradiction Inbox、Uses、source round-trip。

### 10.5 Review Workspace

需要：review template/checklist、issue list、conditional columns、flags/comments/manual input、reviewer、
proposed patch、accept/reject/waive、sign-off、comparison/diff、export。

### 10.6 Evidence Studio

首版：Brief、Matrix。后期：Timeline、Review Memo、Slide/Audio/Study Guide。

所有 artifact 从 pinned ClaimVersions 编译。局部编辑分为 style-only 和 factual change；后者必须重新选择/
创建 ClaimVersion 并运行 coverage。

### 10.7 Personalization Center

需要：Active Profile、Candidate Inbox、Preference Probes、Why used、scope、history/conflict、pause/edit/forget/
export、use/contribute controls。

Personalization 只改变阅读、解释、呈现和后期受控 plan；不隐藏 Sources/Conflict/Unknown。

## 11. 真实业务场景发散

| 场景 | 默认 View | 必需交互 | 主要风险 |
|---|---|---|---|
| 季度财报/投资研究 | Desk + Timeline + Matrix | KPI table citation、跨期 compare、watchlist、旧 thesis impact | 口径/期间混淆 |
| 合同谈判 | Compare + Review | clause alignment、red flag、comment、decision、sign-off | 用户目标被误作合同事实 |
| M&A/尽调 data room | Matrix + Issues | source scope、request list、coverage、owner、new-file impact | 大量文件和缺失材料 |
| 审计 | Review + Claims | evidence sufficiency、sampling scope、waiver、reviewer | false closure |
| 系统综述 | Library + Matrix | screening、PICO/criteria、extraction cell、PRISMA-like flow | inclusion bias/漏检 |
| 政策/法规跟踪 | Timeline + Impact | version effective date、obligation/control mapping、alert | 旧法规继续被引用 |
| 采购/RFP | Matrix | requirement × vendor、missing answer、score rationale、source cell | score 无来源 |
| 工程规范/API | Compare + Impact | requirement→decision→test trace、revision diff | node ID/版本漂移 |
| 医疗/临床资料研究 | Evidence Desk + Review | guideline date/population/strength、primary evidence | 高风险误用；必须 human gate |
| 调查报道 | Timeline + Claims | attribution、独立来源、anonymous permission、contradiction | source 身份泄漏 |
| 教学/学习 | Reader + Notebook | highlight、question、concept map、quiz、Preference Probe | 学习状态污染事实层 |
| 高管 Brief/团队交接 | Studio + Notebook | claim reuse、source links、decision/open question、update available | 摘要掩盖不确定性 |

### 11.1 财务研究完整旅程

1. Library 将 filing、earnings、presentation、transcript 按公司/季度/role 分组；
2. 用户锁定 Q2 + Q1 source scope；
3. Agent 先给 research plan 和 expected KPI table；
4. Answer 中每个数字 citation 跳到 table cell，保留 row/column header 和单位；
5. 点击“与上季度比较”打开双 pane 或 timeline；
6. Research Memory 提示旧 thesis/OpenQuestion，用户选择加入；
7. 新报告与旧 Claim 不一致时进入 Contradiction/Impact；
8. Brief 发布后 Watchlist 新材料只提示 affected claims，不自动重写。

### 11.2 合同审查完整旅程

1. document type detector 建议 Contract Review template，用户确认；
2. Compare 按 clause 对齐 draft v2/v3，不按页同步；
3. conditional columns 先抽 governing law，再运行 jurisdiction check；
4. sentence/cell citation 点击原 clause；
5. 用户 flag 红/橙/黄、写 comment、设置 manual decision；
6. Agent 可总结 red flags，但必须引用 table metadata + source；
7. sign-off 记录 reviewer/scope/time；
8. 新 revision 到来显示 impacted decision，而非把旧评论贴到相同页码。

### 11.3 尽调完整旅程

1. 大量文件进入 candidate Library，按 entity/type/date/permission 过滤；
2. request list 每项显示 required evidence、included docs、coverage 和 owner；
3. Agent 处理时 Matrix cell 持续出现 proposed answer/citation；
4. 人在 cell 层 accept/comment/request-more；
5. 缺失材料保持 unknown，不用“未找到”代替 false；
6. 新文件到达后 only impacted open questions 提示 refresh；
7. 输出 memo 从 reviewed cells/claims 编译。

### 11.4 系统综述完整旅程

1. 保存 search query、数据库、日期和 inclusion criteria；
2. papers 进入 screening queue，显示 title/abstract/full-text stage；
3. 每个 include/exclude decision 有 reason、reviewer 和 source；
4. extraction table 的每个 cell 有 sentence citation；
5. methods/results/limitations selection 可直接问或形成 Claim；
6. conflicting studies 进入 Claim Matrix，不由 summary 自动平均；
7. report 生成时保留 coverage、excluded reason 和 unresolved extraction。

### 11.5 工程规范完整旅程

1. Series 把 spec v1/v2 与 implementation notes 分层；
2. 用户选择一个 requirement 直接问“哪些 tests 覆盖它？”；
3. Answer 的 requirement、decision 和 test 分别跳到对应 source；
4. new spec revision 触发 impact view；
5. user decision 与 spec fact 使用不同卡片；
6. old implementation note 若无 source 标 unverified。

## 12. Domain templates 与个性化

### 12.1 Template 是 View/Review 配置，不是新事实模型

```text
Financial    period/KPI/guidance/table context
Contract     clause/obligation/date/jurisdiction
Research     PICO/method/population/outcome/limitations
Due diligence request/issue/owner/coverage/closure
Procurement  requirement/vendor/score/missing evidence
Engineering  requirement/decision/test/revision impact
```

底层仍是 Document/Evidence/Claim/Decision/Review/Artifact。用户可随时切回 Generic，template 不得把未抽取
字段解释为不存在。

### 12.2 可个性化界面

- 默认 PDF/Text/Compare；
- answer order、explanation depth、evidence density；
- panel density、font、follow mode；
- preferred template/columns；
- citation preview 展开程度；
- familiarity/terminology。

不能个性化隐藏 conflicting source、unknown、stale、permission 或 verification failure。

### 12.3 Preference Probe

同一 AnswerManifest 以两个 renderer 显示，例如 conclusion-first 与 evidence-first；Claim/Evidence/conflict
集合完全相同。长答案只显示局部 diff。选择可以仅本次/项目/同类任务/全局，并与实际 time-to-evidence、
correction、review completion 分开记录。

## 13. 状态、空态和失败态

| 状态 | 必须告诉用户 | 推荐动作 |
|---|---|---|
| no sources | 为什么不能问 source-grounded question | Add/import source |
| processing | 当前 stage、progress、可取消性 | View details / cancel |
| partial ready | 哪些 pages/representations 可用 | Continue with limits / wait |
| text empty/sparse | OCR/visual capability 和成本 | Use visual / request OCR |
| no result | searched scope/coverage；不是 absence proof | Broaden scope / sequential |
| truncated | returned/total、cursor | Load next |
| stale locator | old/current revision、selector conflict | Open old / re-anchor |
| permission lost | 不泄漏 source 内容 | Request access / remove |
| conflict | 哪些 claims/evidence 冲突 | Compare / human decision |
| cancelled | durable completed/unknown/pending steps | Resume / discard |
| provider error | provider、retryability、request scope | Retry / fallback |
| offline/reconnecting | cached content、unsynced edits | Keep local / cancel |
| version conflict | local vs authoritative revision | Merge / reload / retry |
| deleted source | impacted notes/claims/artifacts | Restore / redact / acknowledge |

Toast 只用于低风险瞬时确认；需要用户决定的状态进入 persistent banner/inbox，不自动消失。

## 14. DSH 具体集成设计

### 14.1 Slots

| DSH seam | DocAtlas 用法 |
|---|---|
| `conversation.view` | 注册一个 `docatlas` 主 View；内部切 Desk/Notebook/Claims/Review/Studio |
| `conversation.chat.assistant-actions` | 每条 finalized answer 的 View Sources / Open Evidence |
| `conversation.input.dock` | selection context tray、scope/pending chips |
| `conversation.input.left/right` | Add source、mode、strictness 等紧凑控制 |
| `conversation.session.header.actions/utilities` | source scope、Library、export、background status |
| `conversation.details.tool` | Search/Read/Verify 专用详情，可回 locator |
| `shell.overlay` | modal/dialog/toast；不用于挤出主布局或 DOM patch |

### 14.2 Focus

`openView('docatlas', focus)` 的 focus 是一次性 opaque ID。Client 不解析包含 filesystem path 的 JSON token；
它把 ID交给 Host resolve，完成后调用 `completeViewRequest()`。Focus request 要幂等，页面 reload 后可通过
answer/citation action 重新发起。

### 14.3 RPC/stream 草案

```text
docatlas.workspace.getSnapshot(sessionId)
docatlas.workspace.stream(sessionId, afterRevision)
docatlas.library.list/filter
docatlas.sourceScope.preview/commit
docatlas.locator.resolve(focusId)
docatlas.selection.stage/consume/cancel
docatlas.note/claim/review command APIs
docatlas.answer.getManifest(messageId)
docatlas.preference command/query APIs
```

所有 unary/stream item 使用生成 codec，支持 AbortSignal、mount disposal、generation reconnect 和 domain-owned
resume cursor。普通 one-way notification 不承担唯一状态真相。

### 14.4 Exact Fetch routes

```text
GET/HEAD /api/docatlas.pdf?assetId=...
GET/HEAD /api/docatlas.page?representationId=...&page=...
GET/HEAD /api/docatlas.asset?assetId=...
GET      /api/docatlas.export?artifactId=...
```

Host 解析 opaque ID、检查 session/workspace/source permission 和 content root；支持 Range/ETag/content hash/
content-type/size limits。静态前端 asset 可公开，但任何文档/annotation/artifact 数据都必须认证。

### 14.5 Optimistic mutation

Note/comment/flag/review edits 使用 Host-owned version compare-and-set：Client 提交 last seen version；冲突响应
携带 authoritative item，允许 merge/retry，不静默 last-write-wins。每个 domain object mutation 串行或事务化。

## 15. Client 状态与组件

### 15.1 状态归属

| 状态 | 存放位置 |
|---|---|
| hover、popover、临时 zoom、open drawer | Client memory |
| panel width、font、default representation | local/profile preference |
| composer draft | DSH conversation store |
| staged selection | Host nonce + visible Client chip |
| active source scope | Host domain + Session projection |
| Evidence/Claim/Note/Review/Artifact | Investigation Journal |
| Agent/tool status | DSH Session Log + projection |
| PDF/page/figure bytes | authenticated blob/cache |
| Personalization candidate/use | Personalization ledger |

### 15.2 核心组件清单

```text
DocAtlasViewShell
WorkspaceBreadcrumb / ModeSwitch / AgentStatus
LibraryDrawer / SourceScopeDrawer / ScopeDiff
DocumentTree / SeriesTree / FilterBar
PDFReader / TextReader / CompareReader / FigureViewer
PageControls / RepresentationBadge / TextQualityBadge
SelectionToolbar / ContextTray / AnnotationLayer
AnswerManifestView / ClaimSpan / CitationGroup / CitationPopover
EvidenceInspector / DerivationInspector / CitationHistory
InvestigationPlan / CoverageMap / OpenQuestionList
ResearchNotebook / RelatedPriorWork
ClaimCard / ContradictionInbox / ClaimMatrix
ReviewChecklist / ReviewTable / IssueInspector / SignoffBar
ArtifactEditor / ImpactBanner
PersonalizationChip / PreferenceProbe / WhyUsed
LoadingEmptyErrorState / AccessibleStatusAnnouncer
```

组件共享 typed IDs/state，不在 React component 内发明第二套业务状态。

## 16. Responsive、Accessibility 与国际化

### 16.1 Breakpoints

| 宽度 | 布局 |
|---:|---|
| ≥1400 | 三栏；可开 citation/evidence rail |
| 1050–1399 | reader + investigation；outline drawer |
| 760–1049 | 单 reader；左右互斥 drawer |
| <760 | 单列；source/answer/claims 为 top-level segments，actions bottom sheet |

Compare 在小屏变成 A/B switch + synchronized claim card，不强制并排缩到不可读。Matrix 在手机优先按 row
展开，不横向显示全部列。

### 16.2 Keyboard

- landmarks：Library、Tree、Reader、Investigation、Composer；
- citation next/previous、open、return；
- tree expand/collapse；
- selection toolbar 和 context chips 全键盘可达；
- Esc 有层级：popover → drawer → selection；不误取消 Agent；
- keyboard focus 不被 sticky composer/header 遮挡；
- shortcut 可发现、可关闭，不劫持 screen reader/browser 常用按键。

### 16.3 Screen reader/status

- citation focus announce `Report A, revision 2026-06, physical PDF page 17, exact quote highlighted`；
- search/read progress 使用 `role=status`/appropriate live region，不每个 token 打断；
- conflict、stale、unknown 不只靠颜色；
- virtual list 保持 semantic row keys、ARIA indices 和 focus；
- canvas/PDF highlight 有等价文本与结构化 locator；
- target 至少 WCAG 24px，主要 touch action 目标 44px。

### 16.4 国际化

- CJK/RTL/vertical text 的 quote normalization 和 offset 测试；
- physical page 与 printed page label 同时显示；
- locale 不改变 citation ID/hash；
- table number/date/unit 格式化不改 source exact value；
- UI 文案和 document/user content 分离，防止把 source 当 locale key/HTML。

## 17. 性能设计

- PDF 使用 authenticated Range、page virtualization、canvas/text/annotation layers；
- 只预取视口前后少量页，切文档时 abort；
- page bitmap/figure/quote preview 使用 size-bounded LRU；
- citation hover 延迟加载，focus/click优先；
- normalized text map 在 representation ingest 时建立；
- document/tree/matrix/trajectory 全部 windowing + cursor pagination；
- source scope counts由 Host 聚合，不让 Client遍历全库；
- answer streaming 先显示稳定 text，citation 状态在 manifest segment ready 后原位升级；
- settled answer 的 segment IDs 不因后续 token/format 改变；
- background jobs 使用 delta stream + catch-up cursor；
- browser memory、DOM nodes、bitmap bytes、RPC payload、TTI、citation focus latency 纳入 telemetry；
- telemetry 记录尺寸和状态，不记录 secret/source正文。

初始目标沿用：cached citation focus p50 <200ms、本地首次 page p95 <1.5s；真实浏览器测试后再冻结。

## 18. 安全与隐私

1. PDF 内嵌 JS/附件不执行；外链离开应用前确认。
2. Markdown/OCR/model summary 严格 sanitize；relative asset 转 opaque ID。
3. Client 不能提交 server path；Host 做 document/asset resolution 和 containment。
4. Selection nonce session-bound、single-use、expiring；preview/hash 与 source revision 校验。
5. citation/Note/comment/answer 全是不可信 data，不能改变 UI command/tool permission。
6. source role 明确 primary/imported/user/model-derived，阻止 derived self-support。
7. share/deep link 先检查 recipient source/annotation权限；permission denied 不泄漏 filename/quote。
8. private Note、anonymous source、legal matter 使用独立 visibility；搜索索引同样做 ACL filter first。
9. export 显示 source scope、revision、citation status、review status，不导出 bearer/cookie/path。
10. Personalization、Research Memory、source scope 使用独立开关和删除语义。
11. OCR correction、re-anchor、Claim edit 都创建新 version，保留 audit。
12. clipboard/print/download 受 workspace policy 控制，UI 明确何种数据离开本地。

## 19. 应避免的 UI 方案

- 用 iframe 作为最终 PDF reader；
- 通过 DOM margin patch 把 DocAtlas 挤在 Chat 旁；
- Agent read 自动滚走用户当前页面；
- 每个 tool call 画一个巨大 panel；
- citation 只显示页码，没有 revision/quote/bbox/status；
- 整句含多个事实却只给一个模糊 citation；
- hover 是唯一查看来源方式；
- Library 中所有文件默认进入每个问题；
- 用“已连接 300 sources”暗示 300 份都被 grounding；
- 把 Compare/Matrix/Timeline 各自保存为独立事实；
- annotation、comment、flag 只改 Client state；
- 把 Note、Memory、Claim、Source 混成一列卡片；
- 自动生成 graph 作为主导航；
- preference 隐藏 conflict/unknown；
- background Agent 静默更新 published Artifact；
- 空白/错误只显示 spinner 或 `Something went wrong`。

## 20. 分阶段 UI 实施

### UI0：Interaction contracts 与无后端 prototype

- AnswerManifest/Segment/CitationPresentation；
- focus state machine；
- SourceScopeVersion；
- SelectionContext/nonce；
- desktop/mobile wireframes；
- real content fixtures 和 keyboard flows。

Exit：不连接模型也能演示 answer citation → exact fake source、multi-citation、stale/error、selection chip。

### UI1：Citation-first DSH vertical slice（M1/M2）

- 一个 `conversation.view` DocAtlas Desk；
- message assistant action “View sources”；
- authenticated PDF Range；
- single document PDF/text reader；
- tool/answer locator focus；
- user/agent cursor；
- cold replay。

Exit：一条真实 Luna answer 的每个 factual segment 可跳到正确 PDF 段落，刷新后仍可重放。

### UI2：Selection 与主动阅读（M2）

- text/table/figure selection；
- context tray + atomic submit；
- ask/explain/save evidence/Note/OpenQuestion；
- annotation list 和 Show on Page；
- citation keyboard/accessibility。

Exit：用户不需描述页码即可对选区追问；错误/过期 selection 不会附错消息。

### UI3：多文档组织（M2/M3）

- Library、Series、Source Scope Drawer；
- document roots/filter/bulk operations；
- Compare Lab、scope counts、revision badges；
- eligible/included/used/cited/excluded/candidate；
- multi-doc same-page browser tests。

Exit：两份都有 p.2 时，citation/selection/Note/Tree Overlay 均不会串文档。

### UI4：Research Notebook、Claims 与 Review（M3/M4）

- typed Note/Question/Decision；
- Research Overlay/Related prior work；
- Claim Ledger、Coverage、Contradiction；
- Review Table/checklist/comments/flags/sign-off；
- Brief/Matrix Studio。

Exit：selection → Evidence → Claim → Challenge → human Review → published Brief 完整可操作。

### UI5：Research Continuity 与影响分析（M5）

- recall-to-reverify；
- source inclusion confirmation；
- Changed since last time；
- Continue OpenQuestion；
- Timeline/Impact views；
- monitoring/watchlist candidate inbox。

### UI6：Personalization（M6）

- use/contribute controls；
- Personalization Center；
- why-used chips；
- Preference Probe；
- low-risk reader/answer adaptation；
- non-interference visual/eval gates。

### UI7：协作与扩展（M7）

- private/team annotations、mentions、assignments；
- role/permission-aware review；
- remote providers、team memory/profile sync；
- more Studio artifacts；
- cross-device/offline strategy。

## 21. 首发最小但完整的 UX 闭环

```text
选择两份 PDF
→ 明确 source scope
→ 提问
→ Agent locate/read
→ answer factual spans 全部带可点击 citation
→ 点击切到正确 document/revision/paragraph
→ 选中一段原文直接追问
→ selection chip 与消息原子提交
→ 保存 Evidence/OpenQuestion
→ 返回 answer
```

这个闭环优先于完整 Notebook、Claim Ledger 或 Personalization，因为它直接验证用户最重要的信任动作。

## 22. UI 测试矩阵

### 22.1 Citation

- single/multiple/qualifying/refuting evidence；
- same sentence multiple claims；
- text/table/figure/OCR；
- wrong revision、stale quote、bbox mismatch、page-only fallback；
- cross-document switch、pinned source、back to answer；
- copy/export/deep link；
- keyboard/touch/screen reader；
- streaming→settled manifest。

### 22.2 Multi-document

- 1/2/10/100/300+ sources；
- duplicate/same filename/same page/different revision；
- folder/provider permission changes；
- scope preview/commit/rollback；
- eligible vs used vs cited counts；
- Compare alignment、Matrix pagination、Timeline；
- source delete and artifact impact。

### 22.3 Selection

- text/table/figure/area/multi-range/cross-document；
- expired/replayed/wrong-session nonce；
- selection changes while staging；
- remove/reorder chips；
- one-shot/pinned；
- only-selected vs allow-more-sources；
- mobile handles、keyboard、RTL/CJK。

### 22.4 Agent and domain actions

- progress/steer/pause/cancel/resume；
- scope change while running；
- approval/rejection；
- optimistic edit/version conflict；
- cold replay/reconnect/gap repair；
- Note→source、Claim→Evidence、Review→Issue round trips；
- personalization on/off visual and factual parity。

### 22.5 工程测试

- component/unit/property tests；
- generated RPC codec tests；
- Playwright Chromium，随后 Firefox/WebKit；
- axe/manual keyboard/screen reader passes；
- visual regression at breakpoints/themes/zoom；
- PDF corpus：text/scanned/rotated/double-column/table/figure/long/CJK/RTL；
- performance trace、memory/DOM/bitmap budget；
- auth/path/CSP/sanitize/fuzz tests。

## 23. 产品指标

```text
Citation resolution rate
Exact-region focus rate
Median click-to-source latency
Time to first relevant evidence
Answer factual-span coverage
Source-scope correction rate
Selection-to-question conversion
Selection misattachment rate（目标 0）
Wrong-document focus rate（目标 0）
Challenge/contradiction discovery
Review completion and false-pass rate
Prior-work reuse and stale detection
User/Agent cursor interruption rate
Probe dismissal/fatigue
Accessibility task completion
```

“citation 被点击少”不能单独解释成 citation 无用；用户可能已从 hover preview 完成核验，也可能根本不信
系统。需要结合 resolution、correction、review 和 task outcome。

## 24. 建议决定与未决项

| ID | 状态 | 建议决定 |
|---|---|---|
| UI-001 | 建议确认 | 首发最高优先级是 factual claim-span → exact original context |
| UI-002 | 建议确认 | Chat/DocAtlas/Trajectory 是 DSH 一级 View；DocAtlas 七个产品面在一个内部 shell 组织 |
| UI-003 | 建议确认 | Source Scope 显示 eligible/included/used/cited/excluded/candidate |
| UI-004 | 建议确认 | Selection 通过 Host nonce 与 direct message 原子绑定 |
| UI-005 | 建议确认 | Compare/Matrix/Timeline 共用 Claim/Evidence，不建事实孤岛 |
| UI-006 | 建议确认 | Sources、Related prior work、Why personalized、Agent Activity 分开 |
| UI-007 | 建议确认 | Canonical tree immutable；UI badges 来自 typed overlays |
| UI-008 | 暂定 | AnswerManifest 使用结构化 text segments，避免跨语言 offset 问题 |
| UI-009 | 暂定 | 首版一个 DocAtlas conversation.view，内部 Desk/Notebook/Claims/Review/Studio |
| UI-010 | 暂定 | 主要 touch target 44px，最低满足 WCAG 24px/spacing |

仍需 prototype/讨论：

- Explore 普通 assistant message 如何与 AnswerManifest 原子持久化；
- citation 点击默认立即跳第一条 primary evidence，还是先展示多 source popover；
- pinned reader 时跨文档 citation 使用 split pane 还是 temporary preview；
- selection context 是否可直接使用公开 composer extension，还是必须 staged nonce fallback；
- Library 是 DocAtlas session View 内 drawer，还是未来独立 root-level surface；
- Review Workspace 首版采用 table、issue list 还是二者组合；
- Matrix 最大列数及移动端 card projection；
- Comment/mention/team visibility 在 M7 前是否需要预留 wire fields；
- 何时允许 Watchlist 自动创建 investigation candidate；
- answer streaming citation manifest 的稳定 segment boundary；
- PDF.js 与最终 renderer 的选择、license、range/auth 和 annotation storage prototype。

## 25. 来源说明

本轮复核日期为 2026-08-30。商业功能和限制会变化；引用只用于验证交互模式，不把厂商自报性能数字
作为 DocAtlas 验收依据。主要来源：

- [Gemini Notebook chat](https://support.google.com/gemininotebook/answer/16179559?hl=en)
- [Gemini Notebook Mind Maps](https://support.google.com/gemininotebook/answer/16212283?hl=en)
- [Adobe Acrobat contract intelligence](https://news.adobe.com/news/2025/02/acrobat-ai-assistant-contracts)
- [Adobe PDF Spaces legal example](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/get-started/ai/pdf-spaces-legal)
- [Microsoft Copilot Notebook references](https://support.microsoft.com/en-us/microsoft-365-copilot/add-references-to-your-microsoft-365-copilot-notebook)
- [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Harvey collaborative Review Tables](https://www.harvey.ai/blog/collaborative-review-tables)
- [AlphaSense Deep Research](https://www.alpha-sense.com/resources/product-articles/introducing-deep-research-in-alphasense/)
- [AlphaSense monitoring](https://www.alpha-sense.com/blog/product/monitoring/)
- [AlphaSense institutional knowledge](https://www.alpha-sense.com/blog/product/enhancing-institutional-knowledge-with-generative-ai/)
- [Elicit](https://elicit.com/)
- [Zotero PDF Reader and Note Editor](https://www.zotero.org/support/pdf_reader)
- [LiquidText features](https://www.liquidtext.net/features)
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [WCAG 2.2 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [WCAG 2.2 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

DSH 技术可行性来自固定 source `cd5ef8148158c3a752a658978873241fdf8e2bbc` 中的
`ui-conversation`、`ui-chat`、`ui-trajectory`、`connection` 和 `api/gateway` contracts；它们是只读研究输入，
生产实现仍需通过当前 compatibility matrix 和真实 browser mount 验收。
