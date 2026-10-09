# DocAtlas 文档理解页面：布局与交互设计

> 研究日期：2026-08-29  
> 目标：重新设计适合 DocAtlas 的文档理解页面；不是把 TUI 搬进浏览器，也不是在 Web 中嵌一个终端。
> 本文保留基础布局判断；逐 claim citation、多文档 IA、selection 问答、业务场景、DSH 实现和 UI0–UI7
> 完整规格见 [Web UI 全景设计](16-web-ui-interaction-design.md)。

## 结论先行

推荐主页面叫 **Evidence Desk（证据工作台）**，作为新增的 DSH `conversation.view`：

```text
┌──────────────────────────────── DocAtlas header ────────────────────────────────┐
│ 文档集 ▾  搜索/跳页                     PDF | Markdown | Compare   跟随 Agent ◉ │
├───────────────┬───────────────────────────────────────┬─────────────────────────┤
│ Documents     │                                       │ Investigation           │
│ + Outline     │          Original Source              │ 当前问题 / 计划          │
│               │       PDF page + text layer           │ Findings + Evidence      │
│ ▾ Report A    │                                       │ Agent 当前阅读位置       │
│   1. Summary  │       选区、quote、bbox 高亮           │ Why personalized         │
│   2. Risks    │                                       │                         │
│ ▾ Report B    │                                       │                         │
├───────────────┴───────────────────────────────────────┴─────────────────────────┤
│                    DSH 原生 composer（常驻、由 DSH 管理）                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

它保留 DSH 的 session header、View tabs、model/permission/composer 和 Agent Loop。DocAtlas 只拥有
文档 View 内的三个阅读域；在窄屏上渐进折叠成单页 reader + drawer/bottom sheet。

## 1. 从现有 TUI 保留什么

现有 `/overview` 已验证四类信息有价值：

- Summary：当前问题、分析数量、引用页、下一步；
- Findings：finding、plan、evidence；
- Outline：document tree + `page_findings`；
- History：问题/回答时间线。

还验证了 Tab 切视图、方向键导航、展开/折叠、过滤和导出等动作。Web 版应该保留这些
**信息任务**，不保留终端排版：

| TUI 结构 | Web 对应 |
|---|---|
| Summary | 右侧 Investigation 顶部的 task brief |
| Findings | Evidence ledger，可点击回原文 |
| Outline | 左侧结构树，带阅读/证据状态 |
| History | DSH Chat/Trajectory；DocAtlas 只提供相关活动摘要 |
| `/overview export` | Evidence/Investigation 导出动作 |

TUI overview 是退出聊天后的独立只读页面；Web 的优势是同屏看到原文，所以不应再复制这种切换成本。

## 2. 页面核心对象

页面不是“PDF viewer + chat”，而是一条可双向导航的对象链：

```text
Document revision
  └─ Source representation (page image / text / OCR / Markdown)
      └─ Structure node / page / block / figure
          └─ EvidenceAtom + precise selector
              └─ ClaimVersion + support/refute/qualify relations
                  └─ Artifact claim use / ResearchNote / OpenQuestion / ContinuityLink

Personalization 的 `why-used` 与这条事实/研究链并排展示但不进入其中；它解释界面和策略，而不是支持
Claim。完整 Memory domain 边界见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。
```

任何 card、badge 或高亮都应能沿这条链向下回到原文，向上回到它支持的 claim/artifact。详细状态模型见
[Fact Trace 与可交互 Agent Loop](07-fact-trace-agent-interaction.md)。

## 3. 三栏的职责

### 3.1 左栏：Document Atlas

不要把“文档列表”和“目录树”拆成两个永久侧栏。文档作为 root node，展开后就是其 outline：

- 文档名、revision/provider/处理状态；
- heading 与物理页范围；
- 当前 reader 位置；
- Agent 正在读取的 node/page；
- 已读、存在 Claim/Evidence、存在用户标注的 badge；
- personalized Lens 排序提示，但 canonical order 始终一键恢复。

默认只显示 title 和 page range；summary、typed Research Overlay badges 和 relevance reason 在 hover/展开后
显示，避免一棵树同时承载所有语义。旧 `page_findings` 只作为 migration input，不直接成为新 UI 状态。

### 3.2 中栏：Original Source

中栏永远优先原文，不优先 Agent 摘要：

- `PDF`：页面 canvas + selectable text layer + annotation layer；
- `Markdown`：结构化文本、表格、公式和 figure refs，明确标注“提取视图”；
- `Source ↔ Extracted`：按需左右对照，用于检查 OCR/table 误差；
- `Compare`：双文档/双 revision 并排；
- figure lightbox：保持 document/page/ref/bbox 上下文。

页头显示 `PDF p.17` 与印刷页码（若识别）两种编号，所有工具和 citation 使用物理 PDF 页码。

### 3.3 右栏：Investigation

默认只显示当前任务所需的信息，避免做第二个 Chat：

1. 当前问题和子问题进度；
2. Agent 当前动作，例如“正在读 Report B · p.42–43”；
3. claims，按主张而不是按工具调用排列；
4. 每条 claim 的 evidence chips；
5. supported/contested/unresolved coverage 与 open questions；
6. 本轮用到的 personalization 及 “why used”；
7. 与当前问题相关的旧 Claim、Note、Decision 和 OpenQuestion，明确标记 current/stale/unverified；
8. 对当前页/选区的相关 answer/artifact uses。

DSH Chat 保留完整对话；这里显示的是 document-grounded projection，不显示隐藏 chain-of-thought。

## 4. 四种布局模式

它们共享同一套数据和定位协议，不是四个独立应用。

### A. Evidence Desk（默认，推荐首版）

三栏：outline / 原文 / investigation。适合日常单文档和轻量多文档问答。

### B. Focus Reader

原文占满，左右栏变为窄 rail 或 drawer。适合逐页精读、长时间阅读和小屏。

```text
┌─ page controls ──────────────────────────────────────────────┐
│                                                             │
│                    large source page                        │
│                                                             │
│  ◀ outline rail                         evidence rail ▶      │
└─────────────────────────────────────────────────────────────┘
```

### C. Compare Lab

两个 source pane 并排，右侧变成差异/证据矩阵：

```text
┌──────── Report 2023 ────────┬──────── Report 2024 ────────┬─────────────┐
│ p.31 Risk Factors           │ p.34 Risk Factors           │ Claim       │
│ highlighted source A       │ highlighted source B        │ A evidence  │
│                            │                             │ B evidence  │
└─────────────────────────────┴─────────────────────────────┴─────────────┘
```

同步滚动只在 node/section 对齐可信时开启；不能简单按页码锁步。

### D. Investigation Map

跨多文档时，以 claim 为行、document/revision 为列，单元格是 evidence locator。它回答“哪些结论在哪些
文档中得到支持/反驳/未覆盖”，比再开更多 PDF 栏更清晰。

这是后期创新点，不是首版必需。

## 5. 响应式策略

DSH 自己在 1024px 以下会收起主 sidebar，DocAtlas 应在自身 container 上判断宽度，而非只看 window。

| View 宽度 | 布局 |
|---:|---|
| ≥ 1400 | 三栏；outline 240–300、reader flex、investigation 340–420。 |
| 1050–1399 | reader + investigation；outline 变可打开 drawer/rail。 |
| 760–1049 | 单 reader；左/右都用互斥 drawer，顶部保留 document/page。 |
| < 760 | 单列 reader；目录与 evidence 是 bottom sheet；触控 citation 保持 44px target。 |

用户拖动宽度只保存 presentation preference，不影响证据状态。支持 double-click reset 和
`prefers-reduced-motion`。

## 6. Agent 与人的阅读位置不能互相抢

### 6.1 两个 cursor

- `userCursor`：用户正在看的 document/page/selection；
- `agentCursor`：最近一个 running/settled DocAtlas tool 的 locators。

默认 Agent read 只在 outline 和右栏点亮，不自动滚走用户正在读的页。三种 follow 状态：

| 状态 | 行为 |
|---|---|
| Follow on | 新 Agent locator 到来时平滑定位；用户手动滚动后暂停。 |
| Follow paused | 显示“Agent 已到 p.42”返回按钮，不移动 reader。 |
| Follow once | 点击 tool/claim/citation 只定位这一次。 |

这是文档产品与普通“工具调用卡”最大的体验差异之一。

### 6.2 状态表达

- `searching tree`、`loading page`、`reading page`、`recording claim`、`verifying` 分开；
- streaming/running 用轻动画，settled 后变为历史 marker；
- 错误显示 provider、requested pages、returned pages、重试建议；
- 不用颜色作为唯一状态，兼顾色弱和屏幕阅读器。

## 7. Citation 导航

一次点击的理想路径：

```text
answer citation / claim chip / tool card
  → openView('docatlas', locatorId)
  → 选择 document revision
  → 打开 physical page
  → bbox highlight；没有 bbox 时 exact quote search
  → 都失败时 page pulse + “无法精确匹配”说明
```

不同 revision 不自动迁移 bbox。若 quote hash 与 revision 不符，显示 stale citation，并允许用户打开旧
revision 或手动重锚。

在普通 Chat tab，每条 assistant message 可以通过 additive
`conversation.chat.assistant-actions` 增加“查看来源”按钮，打开 DocAtlas View 并定位该 message 的
第一条 citation；无需替换 DSH assistant renderer。

## 8. 用户选区 → Agent 上下文

选中文字、表格区域或 figure 后，出现克制的 selection toolbar：

```text
[问 Agent] [保存证据] [建立主张] [找反例] [对比] [复制引用]
```

“问 Agent”创建一个可见 composer chip：文档名、p.N、20–40 字 preview；完整 quote/bbox 由 Host
保存为一次性 `SelectionContext`。提交时必须把 selection 作为结构化、标为 document evidence 的
用户 context 写进 DSH session，不能只存在浏览器内存。

实现前要通过一个 contract spike 决定：

- 首选：公开 composer/context extension 能把 chip 与 user message 原子提交；
- 保底：Host 先 stage nonce，draft 中保留可见引用 token，`agent/pre-step` 校验 nonce 后展开并一次性
  消费；过期/不匹配就拒绝，不把旧选区静默附到新问题。

“保存证据”只创建 EvidenceAtom，不自动宣称它意味着什么；“建立主张”让用户或 Agent 明确写 Claim 并
选择 support/refute/qualify。选区不应自动成为长期 memory，另有明确“记住我的偏好”动作。

## 9. PDF、Markdown 与图片实现建议

### 9.1 Source of truth

PDF bytes/revision 是原文权威。Markdown/OCR 是可搜索的派生层，必须显示 extraction provider/version。

首选 renderer：

- authenticated byte/range endpoint；
- PDF.js 类 page virtualization、canvas、text layer、annotation layer；
- page rotation/crop box 进入 bbox 变换；
- 只预取视口前后少量页面；切换文档取消旧请求。

原生 `<iframe src="*.pdf">` 适合极早 demo，但难以稳定做选区、bbox、主题、citation focus 和跨浏览器
行为，不应成为产品基础。

### 9.2 Markdown

- 严格 sanitize，不执行 HTML/script/event handler；
- relative images 解析成 opaque asset id，不直接拼文件路径；
- table 横向滚动，figure 保留 caption 与 page locator；
- 代码/公式延迟渲染；
- 提供“在 PDF 中核验”动作，而不是把 Markdown 当原文。

## 10. Tree、Finding 与 Evidence 的视觉语义

必须使用不同图形/文案：

| 数据 | 表达 |
|---|---|
| Canonical heading | 普通 tree row，显示 page range。 |
| 模型生成 summary | `AI summary` 次级文本，可折叠。 |
| legacy `page_finding` | 仅迁移/诊断，不直接显示为已验证事实。 |
| Research Overlay | 独立 Evidence/Claim/Note/Question badges，可打开来源、status 和历史。 |
| 用户标注 | 独立 annotation icon。 |
| personalized relevance | “因为你关注现金流” lens chip，可关闭。 |
| Agent 当前路径 | transient cursor，不写回 canonical tree。 |

这避免现有 tree 中 summary、finding、query-conditioned observation 越积越像“原文目录”。

## 11. Claim Ledger 的交互

商业产品给出了三类成熟模式：Gemini Notebook 的 citation hover/click、LiquidText 的摘录与原文双向
链接、Hebbia/Harvey 的 cell-level citation + flag/comment/sign-off。DocAtlas 应把它们统一为 Claim Card：

```text
┌─ Supported · 2 evidence · Human reviewed ───────────┐
│ 2024 operating margin was 18.2%.                    │
│ Report 2024 p.31 · Table 4                          │
│ Derived: operating income / revenue                 │
│ [原文] [找反例] [改写] [拆分] [历史]                │
└─────────────────────────────────────────────────────┘
```

Claim Card 的直接操作：

- `Open source`：定位 precise selector；
- `Attach/Reject evidence`：修改 relation，不改 quote；
- `Challenge`：steer Agent 搜 counterevidence；
- `Reword`：新建 ClaimVersion；
- `Split/Merge`：修正 atomicity；
- `Mark unknown/out-of-scope`：不把 absence 当 false；
- `Review/Return`：记录 actor、time、scope；
- `Uses`：查看 answer、matrix、brief、slide 中的使用位置。

右栏顶部提供 Coverage View：用户问题的 subquestions × claim status，而不是一个不可解释的总置信分。
存在冲突时出现 Contradiction Inbox；不强迫系统自动挑一个赢家。

## 12. 个性化如何出现在页面里

个性化应可见但不喧宾夺主：

- 打开文档时恢复用户偏好的 PDF/Markdown、栏宽和密度；
- outline 可切 `Canonical / For this question / For me` Lens；
- 右栏显示“本次阅读策略：先风险变化、后财务表；依据 2 条 workspace preference”；
- 每条 personalized rank 有 why chip；
- “不相关”会降低该 memory 的 utility，不修改文档 relevance truth；
- Personalization Center 提供候选、active profile、冲突与历史。

不要做人格化动画来替代解释，也不要默认弹出“我学到了你…”打断每个问题。

### 12.1 自适应校准与旧研究召回是两种交互

自适应界面可以在低风险回答后显示一个轻量 `PreferenceProbe`：两个版本共享完全相同的
Claim/Evidence/uncertainty backbone，只改变 answer order、解释深度或 evidence density。长回答只显示
局部 diff 或 renderer 切换，不让用户重读两份全文。选择提供“仅本次/本项目/同类任务/以后默认”，一次
选择默认只形成 observation。

旧研究召回则显示为 `Related prior work`，属于 Research Memory，不属于 personalization：

```text
Related prior work                  Why personalized
旧 Claim/Note/OpenQuestion           回答顺序/解释深度/阅读策略
点击进入旧 investigation 与原文       点击进入 Personalization Center
需要 re-resolve/reverify             不参与 factual support
```

如果旧 source 不在当前 scope，必须由用户点击“加入本次调查并比较”后才能使用。页面上的 Sources、Related
prior work、Why personalized 三种入口不能合并成一个 citation 列表。

## 13. View 状态应该存在哪里

| 状态 | 介质 |
|---|---|
| hover、drawer open、临时 zoom | Client memory |
| panel width、PDF/Markdown 偏好、字号 | local UI preference / profile，用户可 reset |
| 当前 session 的 document set、claim summaries、agent cursor | Session/DocAtlas Projection，可从 tool events + Investigation Journal 重建 |
| 每个 revision 的 last user page | presentation sidecar；不进入模型，允许跨 session 恢复 |
| evidence/locator | Host evidence store + session log pointer |
| personalization candidate/usage | Memory ledger |

不能像普通工作台一样把 document binding、evidence 和 memory 全放 localStorage；清浏览器缓存后不应
丢失研究状态。

## 14. 性能预算

- Session `tool/result.meta` 只放 locator/summary/id，不放整页/base64；
- tree 采用 outline pagination 或按 node lazy load；
- PDF canvas 只保留有限 LRU，离屏 page 释放大 bitmap；
- page image/figure 使用 binary Fetch，支持 ETag/content hash；
- 快速滚动时显示低分辨率 thumbnail，停止后升级；
- quote highlight 建索引时做 normalized text map，不在每次 citation click 扫整份文档；
- Agent read 和 user reader 共用 page cache，但拥有不同 cursor；
- p50 citation focus 目标 <200ms（缓存命中），p95 首次 page <1.5s（本地普通 PDF）。

## 15. 安全与可访问性

- PDF、Markdown、链接和 model summary 全部是不可信输入；
- PDF 内嵌脚本/附件不执行，外链离开本地应用前确认；
- 所有资源经 DSH Connection 认证和 document-id 授权；
- keyboard：outline/reader/evidence 之间有明确 landmark 和快捷键；
- focus 跳转后 announce `Report A, PDF page 17, quote highlighted`；
- highlight 具备纹理/边框，不只靠颜色；
- zoom、字号、对比度、reduced motion 可配置；
- mobile bottom sheet 不遮住 DSH composer 和系统键盘。

## 16. 社区二次开发与商业产品带来的判断

DSH 社区已有 PDF preview、Markdown outline、annotation、right sidebar、popout window、dock layout 等
大量插件，说明“在 Chat 旁看文件”是强需求。但多数是通用文件预览或通过 overlay/DOM margin 拼出
工作台，缺少：

- document revision identity；
- quote/bbox citation；
- tool event → reader focus；
- claim/evidence ledger；
- memory why-used 与治理。

Notebook、Artifacts、Matrix 和 Review Table 进一步说明：artifact 内的 node/cell/section 必须能重新进入
Agent Loop，用户的局部 edit/flag/comment 也必须返回 Claim/Investigation Journal，而不是只改屏幕状态。

DocAtlas 的差异化不应是“又一个 PDF sidebar”，而是 **原文、Agent 行为、证据、Claim、Artifact 和
个性化在同一 provenance 协议上闭环**。

参考目录：[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

## 17. 首版页面删减清单

首版只做：

- 单/多文档 root + outline；
- PDF 原文页与 Markdown 切换；
- Agent/user 双 cursor 与 follow；
- structured EvidenceAtom/Claim 定位；
- 右侧当前任务 + claim coverage + evidence；
- 最小 claim accept/reword/challenge/history；
- DSH composer 常驻；
- 桌面三栏和移动单栏 drawer。

首版不做：自由 tiling、任意网页/终端 pane、Audio/Video Studio、百万文档 virtual tree、完整知识图谱、
团队协同、自动同步滚动、浮夸可视化。Compare Lab 与团队 sign-off 在 locator、Claim Ledger 和单页体验
稳定后再加。
