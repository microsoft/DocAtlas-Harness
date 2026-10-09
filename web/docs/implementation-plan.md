# DocAtlas 完整实施主计划

## 当前交付：官方 main 的独立 Web 迁移（2026-10-09）

用户已确认 [ADR-064](adr/064-standalone-web-main.md)：保留官方 Python CLI/TUI/评测路径，
迁入视频对应 live Web 的完整 grounding 依赖闭包；Web 不要求复现原实验性能。
在独立 checkout `DocAtlas-Harness-Web/` 的 `feat/grounded-web` 分支实施，官方基线
`5a3d67e0e2a5736198cc7a88d8945b0c94ef3636`。不改两个既有 Python checkout，不移动真实数据，
本批不远端 push 或改变官方 main，产物是可审阅合入的完整集成分支。

本批独立功能的本机验收已通过：目标 Web 2739 项 JS、1474 项 Python 与 56 项浏览器
旅程通过；保留 1 项 ADR-062 已退休旧面板旅程的原有跳过。原 CLI 的 168 项测试及代码/
清单/锁文件零差异复核通过。准确命令、源码哈希、环境限制和历史失败保留在迁移队列；
这些结果不代表真实模型/语料效果、公网部署或长期 R1–R7 已完成。

执行/验收以 [迁移队列](migration/main-web.md) 为准：独立安装与原包保护、真实 tree/combined
Search、Office Intelligence 风格 UI、PDF grounding/原生生命周期复核、UI 竞态修复及新旧检查。全量长期
R1–R7 gate 仍按下面的历史计划推进，不将本次交付冒称公网部署或全部恢复能力完成。

> Canonical living plan · v1.9 · 2026-09-10
> 目标：DocAtlas-first product，嵌入完整 Pi runtime。
> 最新修复（ADR-056）：已补当前附件模型上下文与Read模式说明，真实Luna仅问“总结全文”在6次调用内读完6页测试PDF并通过摘要/引用/同版原件定位；输入区附件/输入/操作同框，13条浏览器和完整check.sh通过，已更新4177。合成验证不代表任意语料质量，精确记录见任务板。
> 当前交付：按用户明确要求已移除本机Web配对/登录（ADR-055），4177打开即用，仅loopback直接访问，保留Origin/CSRF与服务端身份和文档权限；不扩展公网访问。全量check.sh通过，免登录浏览器流程和实际运行服务已核验；精确验收记录见任务板。
> 最新交付：按用户要求简化为上传/聊天/按需原始PDF，首次上传或发送自动幂等建会话，当前文件标签明确展示；高级入口收起而非删库。全量check.sh与最终18条浏览器回归通过，已更新4177本机服务。精确验收范围见任务板，不代表所有长期计划完成。
> 第二十六批：ADR-053显式v2 Flash双路frontier/DAG与整job预算/actual join、ADR-054同意后的低频邀请/跨独立研究选择积累/独立确认已接。四条相关真实Pi/PDF网页旅程通过，3次真实Azure Luna调用再次通过合成PDF问答/原件引用；全量检查与交付服务状态见任务板。旧算法/单次Probe/历史回执保留，完整R1–R7剩余验收不被本批替代。
> 第二十五批：ADR-052接入独立人类研究工作面、无选区Note/Question/Decision/Policy、原PDF选区直接保存、全文版本编辑与只读页标记；不动Ask票据/来源、不调用模型、不制造Evidence。Core同journal升级v5→v6并先备份，原命令回执与记录同事务；集成验收以任务板本批记录为准。PageIndex/SDK发布与scope复核见research/38，pins未变；有界并行增强仅为待评审候选。
> 第二十四批：ADR-050实际selected-head/navigation/fork、Catalog v2交接、历史原Answer/PDF与按需Web面板已接通并通过真实SDK/HTTP/浏览器旅程；整仓check.sh通过，最后Stop绑定CAS修补后的有序构建/类型/74项定向和真实网页取消另有补验记录。不是完整native parity验收。ADR-051受检Flash编号标题修复通过同hash11项配对/反例和原4类质量gate，解决前批两类空树；上游pin未变。精确范围见任务板。
> 第二十三批：手动Pi压缩/可证取消/原键恢复/Web入口按ADR-049接入，整仓check.sh、最终host/SDK定向与真实PDF浏览器旅程通过；全检和最后join修补后的补验范围分别记录。新增真实生成PDF质量gate并修复有界中文子串检索；同hash80页召回0/80→80/80，两类空树仍未过，不称完整Flash质量完成。最终检查以任务板本批记录为准。
> 第二十二批：原生model/thinking/双queue设置、首问前持久化、native-operation原键证明和真实历史分页已接（ADR-048），真实SDK/隔离/55轮Pi/PDF浏览器旅程通过。冷未决状态禁止扩展factory先执行；完整check与后续UI补验范围见任务板。本批不是手动compact/fork或完整native parity验收。
> 本批B进展：在版本/历史PDF/Continuity基础上，接入同一真实Answer的单变量呈现比较、选择→待确认候选→独立确认→已有偏好应用链（ADR-047），不重新生成两份事实答案。Library的document/原record回执/job-success原子提交与显式旧孤儿修复也已实现。集成验证以任务板为准；自动触发/多轴学习/纵向质量、完整原生控制与恢复/发布仍未完成。
> 当前状态：真实本机Pi Web beta已有启动入口；上传/Library/Read→checkpoint Answer→同版原始PDF引用、选区票据、Flash显式增强和正常关闭后恢复已接。真实Azure Luna合成PDF引用smoke通过；不是语料质量/公网部署验收。完整恢复、研究/个性化和R4–R7仍未完成。
> 新Node文档协调器与单文件PDF worker双层隔离已实现（ADR-028）；不等同于全部Pi/model/extension与产品安全已完成。
> Pi本体也已接独立Linux worker及宿主模型/原生/文档代理（ADR-029）；完整控制/资源/provider/配额与真实Web继续推进。
> 官方pi.exec、资源内容审批/只读快照/撤销及早期取消已内接（ADR-030）；项目/package/UI与完整产品验收仍未关闭。
> Node/Python namespace停止已统一（ADR-031）；初始自有认证HTTP提交/回执/停止已接真实Pi（ADR-032），SSE/快照/Reader/Web继续推进。
> SSE/快照与受验证文本历史投影已内接（ADR-033）；认证前端、完整历史/冷恢复和PDF阅读闭环继续推进。
> 配对live聊天页已接真实HTTP/SSE/Pi与原键重试（ADR-034）；默认launcher、完整恢复/管理与PDF阅读闭环继续推进。
> 管理器/持久归属目录、新建会话和正常关闭后的原生恢复已内接（ADR-035）；异常退出监督/核验、完整管理和PDF阅读闭环继续推进。
> PDF上传/Library索引提交/显式版本选择/Pi Flash+Read与原件浏览已接live（ADR-036）；结构化引用/选区核验和完整R3验收继续。
> 文字选区核验/持久one-shot票据/整组绑定/托盘刷新恢复/原文返回已接（ADR-037）；结构化引用、pin/Compare和完整R3/R5仍未完成。
> Flash summary/expand/full 显式预算作业、独立导航 overlay 与只读 Pi 导航已实现（ADR-038）；不是完整上游优化器等价或真实语料质量验收。
> ADR-039/040接上host Read凭据→Pi checkpoint→Answer/原始PDF及loopback:4177真实启动入口；以[本机beta指南](product/local-web-beta.md)运行，原型/DSH继续独立保留。原表历史“待接”条目以此与任务板最新记录为准。
> 执行状态：[任务板](execution-tracker.md)。
> 后端详细设计：[模块/接口/运行恢复/安全/执行包](architecture/backend-delivery.md)；新工程合同见 ADR-023 提案，尚未冻结。
> 旧计划完整保存在 [DSH v0.2 档案](archive/dsh/implementation-plan-v0.2.md)，不再作为新产品完成度依据。

## 1. 最终目标

### 当前优先级：简化文档理解 Web（用户已确认）

已接入体验修复：[ADR-063](adr/063-immediate-send-feedback.md)。回车/按钮显式发送后即时呈现本地待发送消息，按原请求/回执/快照交接，不再等后端记录才冒出气泡。原稿/选区/原键仍受既有outbox保护，不伪造native消息；定向及1440/390px浏览器发送/尺寸/组合输入/重复回车/刷新回归通过，精确结果见任务板。

已接通：[ADR-061](adr/061-map-summaries-and-question-context.md)，文档地图增加同版章节摘要预览/详情，问题和回答保留可回到原PDF的原始选区上下文。复用已有增强与ticket/提交记录，不增加第二份会话或把选区/摘要升级为Evidence。真实PDF浏览器2项通过，全检与后续集成记录见任务板。

已接入：[ADR-062](adr/062-web-research-workspaces-and-map-updates.md)，二次设计的Note/Review成为可发现的Web工作面，将真实研究新增/修订/撤回与审阅状态投影到Map。主要浏览器验收与全检结果见任务板。遵循research/15和ADR-012，不替换为原版Note/Recall或任意改写canonical目录。

本批体验决定：删除回答下方About these sources、Answer options及独立比较面板，不迁移成另一个冗余标签。正文引用、无效引用禁用与原PDF同版核对不变；Note/Review从研究入口打开。旧比较API、原记录、原键/权限规则和独立受控学习功能保留，新的自然个性化入口需后续设计，不自动启用。

原件显示约束：Reader只展示原始PDF，不在页下追加Markdown/提取文本；所有连续页的透明文字层用于选区与引用定位，样式不依赖当前页状态。相邻页重复文字修复与回归见[ADR-058](adr/058-calm-chat-continuous-reader.md)。

体验精修：[ADR-060](adr/060-document-map-and-interaction-polish.md)。真实目录支持按需文档地图/列表/章节聚焦，聊天保持简洁；长问题折叠与紧凑色块、目录当次Reader复用、PDF滚动隔离和加载shell均不影响证据/选区权限与Pi执行。

选区问答修复：[ADR-059](adr/059-selection-ask-handoff.md)。点击Ask自动核验并附入问题，不再要求第二次Verify操作；未附入/失败/恢复待办阻止发送，成功聚焦并保留草稿，最终由用户明确发送，不自动执行模型。

当前体验批次：[ADR-058](adr/058-calm-chat-continuous-reader.md)。统一聊天排版/编号引用/克制动效，真实Web连续PDF窗口化渲染及按需目录树。保留同版原件、独立A/B和选区准入；不得用动画替代真实加载性能改进。

阅读修复见 [ADR-057](adr/057-answer-markdown-and-pdf-text-layer.md)：真实回答渲染 Markdown，缺失出处统一解释；新回答的引用数量对齐现有128条合同并限制字节预算。原PDF文字层按真实间隔匹配，不虚构高亮；不重写旧Answer或自动重新提问。

先把“上传就能问、引用就能查、选中就能追问”做顺，不再向首屏增加工作台。
默认仅为居中聊天框、直接上传 PDF/拖入、当前提问文件标签；无会话时由首次上传/发送显式触发幂等创建，不调用模型。
新上传只有在同一授权会话内完成索引、核对原件哈希和精确 revision 后才加入本次提问，文件标签清楚呈现并允许移除。
读取已有资料、打开原文、翻页、A/B 对照不隐式改变提问范围；历史上传待办没有新标记时不补造自动选择意图。
原始 PDF 按引用/文件点击展开，出处与选区核验不降级。按最新追加要求，Notes/Review以桌面简洁入口、手机Research菜单按需展开；偏好/运行控制保留在“更多”，不删后端能力或已有记录。
验收必须从首次空白页面开始，覆盖文件选择器、拖入、创建回执丢失重试、手机布局、原文引用和选区；不能仅用已建好会话的测试证明首屏可用。


DocAtlas 是完整的、可积累研究工作、可个性化的通用 Agent 产品；文档理解、证据追踪和研究连续性是其核心优势。
Pi 是完整执行引擎，不是产品 owner；DocAtlas 也不是只包含四个原版 Skills 的可选 extension。

保留六个支柱：

1. 通用执行：原生 Pi tools、Skills/extensions、模型、多模态、session/branch、steering、compaction。
2. Document Intelligence：tree/FTS、五种渐进 Read、PDF/table/figure/OCR、原文精确定位。
3. Evidence & Fact Trace：Claim、支持/反驳/限定、推导、冲突、Review、Artifact。
4. Research Continuity：累积已经完成的、有证据链的研究，新材料能继续并核验旧工作。
5. Governed Personalization：更适合用户理解、核验和决策的呈现/工作流，受控学习、可纠正和遗忘。
6. DocAtlas Web：简洁聊天起点，原始 PDF、选区问答、多文档和研究/代码成果按需展开。

首要业务旅程：财报→核算/图表→对比→发布；论文→复现实验/代码→研究笔记；合同/规范→差异/反证→审阅。
能力覆盖不等于 SOTA；必须同时测通用任务与文档研究效果。

用户已确认 [Prototype 01](product/prototype-01.md) 的现版设计，允许开始后端。首个交付目标是自己的 PDF →
真实流式问答 → 原始 PDF 证据 → 选区追问 → 刷新继续，同时从底座保留无文档的 Pi 原生任务。
后续轮次覆盖多文档、研究记忆、个性化和通用成果交互，不把所有长期功能原型作为底座前置条件。
本轮完成 [后端详细设计](architecture/backend-delivery.md)，新增 [ADR-023 提案](adr/023-product-backend-control-plane.md)；
先用 SDK/lifecycle/isolation 小实验确认工程 seam，再冻结字段/实现，不把设计直接当生产运行结果。

## 2. 当前状态基线

### 赶工交付顺序（2026-09-09 用户要求加速）

优先关闭用户能实际操作的主链，不再把全部远期安全/研究功能作为首个内部可用版本的前置条件。
安全边界不降级，未实现能力不显示成可用，也不将内部配对服务称为公开部署。

| 交付点 | 必须交付 | 仍不代表 |
|---|---|---|
| A：首个可用阅读版 | 受认证的启动入口；自己的 PDF→真实提问→最终引用→同版原始 PDF 定位/可信高亮；选区追问/刷新继续 | 全格式段落定位、全部研究记忆与正式生产发布 |
| B：完整研究工作流 | 多文档/Compare、Note/Recall、Claim/Review/Continuity、可控个性化与偏好反馈 | 未经过质量/恢复/运维验收的生产完成 |
| C：完整计划验收 | R1–R7 对应迁移、原生 Pi parity、真实文档/模型评测、备份恢复与发布检查 | 仅测试数量增长不能替代用户旅程验收 |

可独立代码/前端回归/合同 fixtures 并行，按文件责任隔离；生成物/集成构建由一个集成者收口。
Answer checkpoint 投影、PDF citation 与本机入口已推进到真实smoke；接着关闭关键使用问题并推进B层研究/个性化，不继续扩展非阻塞 Flash 选项。
完整目标不缩减：B/C 尚未交付，不因 A 可运行而标全部完成。

| 类别 | 已有内容 | 新产品状态 |
|---|---|---|
| 环境/contracts | 固定 Node/pnpm/Python/uv、JSON schemas、TS/Python bindings | 保留原位，版本/字段不能静默改变 |
| DSH 后端 | Library/scope、Evidence/Answer、journals、M4、Continuity、Personalization、sidecar | Core拥有stores/Answer/研究与偏好应用；Pi Record/Recall、独立人类四类研究/页标记、M4与版本/Continuity已接；完整研究验收/恢复/数据迁移仍待 |
| DSH Web | Reader/Compare/selection、Research/Claim/Review/Publish/Personalization、chat-first 补丁 | 回归输入；不是满足用户期望的新 Web |
| Downstream DocAtlas | 独立 Git checkout、progressive Read、TUI/core hardening | 继续研究/优化；不是恢复为唯一产品核心 |
| Pi | SDK v0.85.1 + 固定本地补丁、runtime/rebind/checkpoint、精确user entry关联/调度；真实navigation/fork与跨代/跨会话origin | SDK/host/HTTP及真实Web分支/子会话/Stop旅程通过；完整extension/worker/model安全/parity未完成 |
| Flash | pin ae16956；raw/merge、显式 summary/expand/full、独立 overlay；受检编号标题本地补丁 | 同hash生成PDF空树修复与反例通过；非官方版本升级，真实模型/语料/OCR/复杂布局与默认启用仍待 |
| 原型 Web | apps/web：React + PDF.js、预设回答/进度、真实原文/选区/临时笔记 | 可通过 demo 命令运行；不是 Pi 产品，不保存长期 Memory |
| 新包/目录 | Core/runtime-pi/server与loopback Web launcher、Azure Responses、Reader引用/Compare、独立研究、偏好/Probe与Claim/Review/本地成果工作面已接 | 本机beta可启动；全套研究/恢复/真实效果/自动学习/公网与完整迁移验收未完成 |
| 新路线 | ADR-021、Core/runtime/Web/migration specs | 设计已明确，执行按下表逐步验收 |
| 后端展开 | backend-delivery v1、ADR-023 提案、R1 子包 | 原型评审已过；工程合同/隔离/SDK 仍需验证，不是已实现后端 |

旧 M0–M6 的 tests/实现保留，但其 done 只描述 DSH-era 局部产物。新 Pi/Web 的 ported、integrated、accepted 必须
重新记录。已知缺口：真实 source admission 全入口、可靠 PDF 段落高亮、Web 用户体验、runtime durability/security，
以及复杂 OCR/table/figure provider。不得再把单测通过等同于这些缺口已经关闭。

## 3. 已确认的架构不变量

以 [ADR-021](adr/021-docatlas-first-pi-runtime.md) 为新的 runtime/product 所有权依据：

1. DocAtlas 拥有 application、domain、policy、Web；Pi 拥有其完整 execution loop 和 native transcript。
2. 使用 SDK/hooks 不等于把 DocAtlas 定义为 extension；Core 是独立于宿主的产品核心。
3. 不删除/覆盖 Pi 原生能力来简化文档产品，不复用旧 document-only preset。
4. Core 不 import Pi/DSH/React/plugin；Pi 依赖仅在 runtime adapter，Web/transport 在 application。
5. Python 是 document engine，不拥有第二聊天循环、conversation、个人画像、模型凭据或发布权。
6. 一个 conversation 单 writer；子 Agent/后台模型作业有 parent、scope、budget、cancel、accounting。
7. 原文、表征、Evidence、研究资产、个人记忆和执行记录分域；偏好不参与事实支持。
8. Note/Review/Memory 正交；旧 Note/Claim 是 lead，用作新事实前重新准入/读原文/核验。
9. Canonical trees immutable；优化生成新 index generation，研究/个性化用 typed overlays。
10. source 权限/范围先于检索；浏览器只用受权 opaque IDs，native shell 同样受真实 workspace/process 边界约束。
11. 原始 PDF 是 citation 默认落点；没有可信 geometry 就明确 page-only，不改跳 Markdown 或伪造高亮。
12. 保留现有 schemas/IDs/hash；宿主字段语义改变需 contract review/version/migration，不全局替换 DSH 字符串。
13. domain commit、runtime event、browser rendering 是不同状态；未知结果先对账，不盲目重跑。
14. DSH adapter 继续可构建、维持旧事件语汇与认证，直到新产品 gate 允许切换。
15. 工作区/独立 downstream/既有数据不作破坏性搬家，所有迁移有清单、回退和验证。
16. [ADR-022](adr/022-prototype-first-delivery.md)：D0 原型与正式产品分开，模拟回答/进度必须标注；用户评审前不恢复大规模迁移。

## 4. 统一术语与状态域

| 世界 | 权威载体 | 不是什么 |
|---|---|---|
| Source | immutable bytes + revision/representation/index metadata | 模型摘要/用户偏好 |
| Research | Investigation journal：Note/Claim/Question/Decision/Review/Artifact/Continuity | 一段聊天历史 |
| Personal | 独立 Profile ledger | 事实来源或 source ACL |
| Execution | Pi transcript + DocAtlas run/control references | 第二份研究数据库 |

Memory 仍分 episodic（执行历史）、working（本次工作）、research（可继续的有证据研究）、personalization（受控适配）。
Pi Session tree、document tree、research overlays 是三类对象。切换会话分支不撤销共享的 Note/Claim/人类决策。

## 5. 目标运行架构

详见 [Core](architecture/docatlas-core.md) 和 [Pi runtime](architecture/pi-runtime.md)。

~~~text
DocAtlas Web
    ↓ authenticated commands / bounded observations / original assets
DocAtlas Application (apps/server)
    ├─ DocAtlas Core: documents, evidence, research, personalization, workflows
    ├─ Pi runtime adapter: full SDK, sessions, tools, resources, native controls
    └─ Python document adapter: supervised process, PDF/index/render/providers
~~~

DocAtlas 启动并装配应用。内部桥接可用 Pi ToolDefinition、context hooks、extension UI binding，但不把产品数据或
主工作流藏在 extension closure。先复用 SDK，不复制 loop、不全面 fork、不依赖 experimental server/source-only APIs。

推荐一个产品服务 + 受控 Pi worker + Python sidecar，Core/模型 broker 为服务内模块；不引入分布式平台。
推荐同源 HTTP commands + bounded SSE + snapshot/asset，持久提交信箱 + native transcript checkpoint；
worker/session/native I/O/model credential 隔离先做 spike。详见 backend-delivery 与 ADR-023（提案，不是已验证能力）。

R1 必须解决：preflight vs durable acceptance、first-assistant persistence、event ordering/settlement、session rebind、
原生 user Bash/sidecar 的统一取消、generation fencing、browser auth 与真实进程权限。

## 6. 目标领域对象与 Contract 顺序

现有契约不重建：ProtocolError/PageInfo、DocumentRevision/Representation/Locator/Evidence/Scope、Selection、
AnswerManifest、ResearchRecord/Recall/Overlay、Claim/Relation/Derivation/Review/Artifact、Continuity、Personalization。

新增/适配按顺序 review：

1. Product actor/workspace/investigation 与 Pi session/branch/run/call binding；旧 DSH provenance 明确保留。
2. Submission receipt、queue/selection admission、运行状态、unknown outcome、幂等和撤销。
3. Browser command/observation envelope、snapshot/checkpoint/reconnect、dialog/approval/asset authority。
4. Index generation/provider capability（Flash raw/merge/enrichment）、geometry/质量状态。
5. Mixed-task derivation/受管 child job 的执行 provenance 与发布规则；不把计算输出当原文。

每个 parser/生命周期新增点都有 valid/invalid fixtures、语义校验、unknown version、升级/恢复和相称测试。
这份计划没有冻结尚未评审的 JSON 字段或声称已有新 wire contract。

## 7. Agent tools、用户命令与运行交互

保留原生 Pi tool defaults 和用户 trusted configuration。文档 Agent tools 保留 docatlas_search/read/record/recall；
是否新增 verify/publish 专用 Agent tool 单列 review，不能顺带赋予模型用户 sign-off/画像编辑权限。

- Search/Recall 返回候选/lead；Read 返回可校验原文；不能把树摘要或旧 Note 当新 Evidence。
- 一个 docatlas_read 用五种 mode；不为定位/扩展/视觉再堆新工具。
- 模型 content 有 item/char/image/cursor/completeness 限额；details 仅 bounded IDs/hash/metadata，原始大资产按需取。
- 真实失败适配 Pi isError；可恢复未就绪状态给下一步，不能裸 stderr 或伪成功。
- 人类 accept/reject、source inclusion、privacy control、Probe choice、policy、sign-off 是受认证的产品命令。
- Explore/Verify/Publish 是工作强度，不是删 Pi 工具的权限 profile；普通编程无需 SourceScope。

可观察流程：Scope/Plan → Recall → Search/Read → Claim/Challenge → Synthesize/Review → Record。
这是按任务选择的能力，不强迫每个问题走全套。steering after-batch 与立即取消分开，UI 不显示隐藏推理链。

## 8. Progressive Document Core

保留 locate / blocks / expand / sequential / visual、persistent Block Map/FTS、稳定 source identity、预算和 cursor、
visual pixels/bytes 限额、text quality、Locator resolve/re-anchor。sidecar page primitive 只供 Reader，不暴露成另一个模型 tool。

原 DocAtlas reasoning/tree 路径与现有 sidecar FTS 不是同一个检索实现；迁移需对照质量，不能改名后宣称等价。
扫描/乱码/布局复杂时显式 capability/fallback；sequential 有覆盖/窗口，不倾倒整篇 Markdown 和所有 sub-images。

Flash 作为 R5 可选 provider：
raw layout/bookmark tree → deterministic merge → optional summaries/expand。来源和 generation 可识别，初步可读状态
不等待所有增强完成。模型增强进入 runtime job，不使用 Python 隐藏凭据/循环。
worker/CPU/RSS bounds、旋转/中文/表格/OCR、tree update 与证据不失效是硬验收。
详见 [Flash 采用分析](../research/18-pageindex-flash-adoption.md)。

第二十三批增加[可复现生成PDF gate](../evals/flash-quality/README.md)：8/80页中文带书签案例、相同中文无书签案例、英文重复页眉案例，实际走隔离ingest/raw/merge/Search/locate/原PDF bbox。中文连续句内子串的FTS漏检由本地query-time有界补充修复，不改index/schema/vendor/原文；同一请求跨sources共享8192 blocks/200万字符/1600万字符×词工作量上限，超限显式缩小范围，不返回伪完整结果。随后第二十四批以受检编号标题guard修复两类生成样例空树，保持上游pin/旧generation；这些结果不是中文语义检索或完整真实业务语料质量证明。

第二十五批[SDK发布与scope复核](../research/38-pageindex-sdk-followup.md)确认PageIndex/JS SDK主分支仍是现有pin；Python稳定发布为0.2.15，源码0.2.10是构建占位，JS已发布0.8.0不包含所有被审计main接口。SDK文档筛选不替代产品ACL。第二十六批按[ADR-053](adr/053-bounded-parallel-flash-enrichment.md)实施小型独立frontier/child-before-parent增强调度：显式v2、最多2在途、整job最坏输出预留、稳定批次/确定性合并、取消/失败等待全部真实provider结束；旧缺省任务保留v1。未以并行度证明真实模型/语料质量或新上游版本。真实语料必须含失败/OCR/table等且确认使用权，不照搬上游仅running-text benchmark的数字。

## 9. Web 文档与通用任务体验

[Web 产品规格](product/web-experience.md) 是当前 UI 执行依据；[旧全景研究](../research/16-web-ui-interaction-design.md)
继续提供业务场景与细节，但其 DSH shell/强制三栏选择不再有效。

- 开局居中聊天；回答 citation 才展开原始 PDF + 同一 chat，也允许主动打开 PDF。
- source revision/page/真实 geometry 校验后高亮；page-only/ambiguous/stale/forbidden 有不同诚实状态。
- material factual span 可追踪；计算/综合判断说明推导，普通建议/代码任务不伪造 PDF citation。
- Library/Collection/Series/Investigation/Revision 区分，已选/已读/已引用/旧研究 lead 分开。
- selection→context chip→all-or-none submission，所有发送入口统一服务端准备，不只 landing。
- 同一原PDF选区提供独立「加入问题 / 保存到研究」，后者可脱离问题存在，不改票据/草稿/提问来源；无PDF也可直接写四类人类研究。
- Compare 独立 A/B cursor；Agent 不抢用户滚动，follow 可控；窄屏切换同一状态。
- Notebook、Claim Ledger、Review、Studio/Brief/Matrix、Continuity、Personalization 按任务展开，不删能力。
- 原生 terminal/diff/code/artifact、模型/队列/分支/上下文控制有产品入口；TUI-only 扩展明确兼容等级。
- 中性色/单一操作色/柔和证据高亮；响应式、键盘、可访问性、44px主要触控目标、reduced motion 从首版纳入。

性能初始预算（待实测校准）：cached focus p50 <200ms、本地首原文页 p95 <1.5s；大 tree/notes/claims 分页，
原文页采用 bounded cache。预算是验收目标，不是已达标声明。

## 10. Note、Recall 与 Review

保留 Note 的 commentary/hypothesis/bookmark 等语义，Question/Decision/Policy/Claim 是独立类型。
Recall 先权限再 exact/FTS/structured filters，只返回 bounded unverified leads。
Review 分确定性 integrity/coverage、可观察 Agent challenge、human decision；不能把结构校验当语义支持证明。

[ADR-052](adr/052-human-research-authoring.md)已接独立人类作者合同与真实Web：自由或原PDF锚定Note/Question、Decision/Policy、全文/CAS生命周期、working/workspace过滤与精确source/page只读overlay。原文锚点只供回原件，不是Evidence；自由记录不伪造选区/Agent调用。Policy只是研究约定，自动继承/执行另需评审。保存与最小整命令回执同事务，后续修改保留原source hash/会话权限；未知结果保持原键，只查回执不重建已删正文。同一领域库v5→v6先备份，只验证临时迁移，不搬实时用户数据。原Notebook/Agent许可保留为内入口；完整草稿/研究恢复、广泛业务与自动记忆仍需验收。

G0 Integrity、G1 Grounding、G2 Scope、G3 Conflict、G4 Publication 全部保留。
旧 page-only Note 导入为 unresolved/unverified，旧 Review-retrieval 仅做兼容，旧 page_findings 不改 canonical tree。

当前有界产品实现见[ADR-045](adr/045-local-human-review-workbench.md)：六个人类命令接入同一M4 journal，
回答中已完成、已发布的Read引用或已保存选区Evidence可整理为不可变Claim，再创建Brief/Matrix、材料核对声明、
确定性Review、独立签署与本地发布。选择历史审阅范围不改变Pi原生文档准入，不把旧Evidence改写为新scope支持。
发布检查精确Review的最新journal顺序批准，后续拒绝不能被旧批准绕过；已提交发布仅允许原body/key的receipt对账。
整条product command hash进入幂等输入，浏览器保留未知结果的原请求，不自动重发/换范围。derived输入有效性有规则检查，
但表达式存在、人类接受或G0–G4通过均不是算术/语义正确性证明。真实业务与恢复/整套浏览器验收继续，不能将R4-002标全部完成。

## 11. Research Memory 与 Continuity

保留跨 session 已完成研究、Note/Question/Claim/Decision/Artifact、Working/Research overlay、编辑/归档/删除/重建。
新材料 → bounded prior-work lead → scope/freshness gate → 必要的用户纳入 → 重新读旧原文 → 比较/挑战 →
continuing/changed/conflicted/unknown → ContinuityLink。

首版同 workspace、suggest-only，不自动扩大 scope；旧源 missing/forbidden 不能用缓存 Note 冒充 evidence。
Source revision 改变通过独立impact/Continuity记录提示旧 Claim/Artifact需要重核验，不改写历史内容。研究记忆不是个性化的附属开关。

当前有界实现见[ADR-046](adr/046-explicit-revisions-and-continuity.md)：资料中「版本与更新」显式上传到同一document，
CAS固定预期当前revision、保持不可变bytes与历史引用；相同当前bytes复用，历史bytes重导入不自动回滚。
仍获授权的历史原件可在A/B打开并作为下一问题明确选择；默认不切换来源，也不以同名PDF猜版本关系。
Note/Claim/Artifact的「继续核验」只读获取原研究依赖，支持独立版本影响检查；人类选择一个真实completed Answer scope、
两侧来源和新Read Evidence，再明确保存continuing/changed/conflicted/unknown。原Note正文不是Evidence，原出版权限继续检查。
判断固定旧record version及整body/key，原receipt可对账但不自动重新判断；历史scope选项省略与当前材料不完整分别提示。
目前不是自动语义diff、全面impact发现或完整异常恢复。ADR-046后续已把domain版本/原record回执/job成功同事务提交；
旧孤立操作仅由明确原键重试在完整hash/原图像证据成立时补成功，不重新解析文档、不改current、不激活Pi来源，status仍只读。
此局部修复不等于host异常退出后的全面运行接管/硬件掉电/备份恢复验收。

## 12. Personalization 具体方案

完整保留 observation → candidate → policy/confirmation → active version → bounded decision → use/outcome →
correction/supersession/forget。显式偏好可立即生效；一次 Probe 不自动全局化，文档/模型输出不能直接造 active preference。

低风险作用面：表达顺序、解释深度、术语熟悉度、证据呈现、reader layout、artifact format。
source ranking/reading plan/challenge depth 等高影响作用面继续关闭，须额外 longitudinal/non-interference gate；
用户偏好不能让 citation 从原始 PDF 改到 Markdown，或隐藏冲突/弱化 Publish。

Probe 共用事实/Evidence/Scope/uncertainty/conflict，只改一个变量；左右随机，可 both/neither/dismiss，scope 明确。
“喜欢”和“任务更有效”分别记录。既有最多一次/investigation 的上限需要真实用户校准，不强制弹出。

保留 useExistingPersonalization / contributeToFuturePersonalization，与 recallPriorResearch / contributeResearchState
独立控制；Temporary 不隐式贡献；why-used、pause/edit/forget/export、WAL/backups 的 truthful deletion 均迁移。

当前有限实现见[ADR-043](adr/043-ephemeral-personalization-application.md)：仅精确消费的问题、许可中的六轴显式偏好，
在host请求边界追加固定表达指导，不改Pi原生messages/tools/modelText/历史或事实域。真实非空正文观察才记录MemoryUse，
`outcome=unknown`，不是模型遵从/事实正确/页面展示承诺。编辑/暂停/遗忘/关闭使用中止受影响生成并禁止同提交隐藏重跑；
贡献开关/导出/幂等receipt重放独立。新v2 inspection诚实披露状态，旧v1命令保持原键/版本可对账。
主回答/自动压缩/分支摘要以原生context+signal调用身份区分，不把辅助摘要写成MemoryUse；擦除代际由profile存储v2保留，
新v2命令冻结expectedProfileEpoch，旧标签页不得跨擦除重放设置或许可。旧v1在擦除前保留兼容，擦除后必须重新显式选择。
Reader自动重排、自动习惯学习与真实模型on/off事实非退化/纵向效果均未验收，不能将此步称为完整个性化。

当前用户主动Probe见[ADR-047](adr/047-controlled-presentation-learning.md)：从已保存回答按需打开「比较两种呈现」，
同一完整回答/证据/弱证据/不确定性只交换两节顺序，真实内容hash与recipe由Core验证，不额外调用模型。
只有显式贡献许可开启时才可记录；默认仅本次，明确工作区选择也仅形成pending候选，再单独确认才创建MemoryVersion。
关闭贡献不影响过去合法receipt读取或人类独立确认；使用已有偏好仍是另一开关，实际MemoryUse仍不等于有效性证明。
相同controlled Probe只接受一次选择；choice/observation/candidate/原整body回执同事务，擦除epoch阻止旧标签页复活记忆。
Profile仅存opaque来源/hash/类型偏好，不存Answer全文；JSON/Markdown导出共用隐私过滤，补含可导出的未晋升候选与选择。
其他轴、不定时自动建议、从多次行为形成候选与纵向效果仍保留在R4-004/005，不以首个单变量闭环替代最终目标。

第二十六批按[ADR-054](adr/054-consented-preference-learning.md)扩展：独立默认关闭的邀请许可，实际completed+published回答达到3次提交后可给非打断建议；每Investigation统一一个自动校准槽位、profile级10分钟冷却，GET/刷新/关闭不伪造反馈。新的显式workspace学习选择按profileEpoch/workspace/axis/mode积累，至少3个独立Investigation同向且零反向才形成pending候选；每次原键回执和旧null不改写，全部原Answer/源权限不完整则整组不可用，不隐藏反向票。确认仍独立且须最新组digest，拒绝/已有偏好/忘记阻止重复推荐；临时选择不参与未来学习。Profile同库受检v2→v3先备份，旧程序拒绝不理解的新语义。代码/真实旅程集成与完整纵向质量仍待分别验收；不扩大为被动监视、自动激活或漂移重学。

## 13. 实施里程碑与依赖

新 R 编号不覆盖旧 M 编号；每个工作包的状态/验证在任务板记录。

| 阶段 | 工作与交付 | 依赖 | Exit gate |
|---|---|---|---|
| R0 重组 | 本地 Pi pin、源码审计、ADR-021、完整继承清单、Web specs、目录/计划 | 本轮 | 源码可验证；历史保留；旧基线 checks 通过；无假启动声明 |
| D0 交互原型 | Prototype 01 核心链；后续多文档/研究/个性化/通用任务原型；用户评审与首发功能范围 | R0 | 明确真/模拟/未实现；真实原文操作；关键 UX 获用户确认 |
| R1 Runtime/contract foundation | runtime binding/submission/auth/event review；Pi 可构建 adapter 与 native parity 最小基线 | D0 首发交互确认 | 无 PDF 的原生任务能跑；first-prompt/retry/rebind/cancel tests；新契约清晰 |
| R2 Core extraction | domain stores/algorithms/use cases/ports、Python supervisor、旧 DSH wrapper 复用 | R1 contracts；纯模块可先做 | Core 无 host imports；旧/new adapter 行为对照；复制数据 migration/backup |
| R3 Product Web vertical slice | product server/Web/auth、统一 source admission、原始 PDF citation、selection/Compare/native activity | R1 + R2 document/evidence | 真实 Pi+server+sidecar 全流程；不是 reader mock 或 CSS skin |
| R4 Research/Personalization integration | Notebook/Claim/Review/Publish、Continuity、Profile/Probe/why-used | R2 + R3 | 所有重模块可用；跨 session/revision、non-interference、privacy 验证 |
| R5 Fast/robust document engine | Flash provider、progressive ingest、quality/fallback/geometry research | R1 provider review；可与 R2–R4 分工 | 原/新 tree 同条件质量/成本/资源评测；不丢 evidence 或隐藏模型 |
| R6 General/mixed workflows | 完整 native parity、文档+计算/代码、受管 jobs/可选 agents/extensions | R1 + R3；成果治理依赖 R4 | native能力未退化；derived provenance、scope/cancel/accounting；真实业务任务 |
| R7 Product release/migration | 数据/历史访问、升级/恢复、性能/安全/UX/full browser gates、默认启动切换 | R1–R6 的首发 gate | 用户主流程验收和回滚演练通过；不以测试数代替可用 |
| R8 后续扩展 | Cloud/provider、Series 增强、Timeline/Studio、team/profile sync/ACL | 对应 contracts/评测成熟 | 显式 scope/consent/retention；当前 deferred |

执行顺序：D0 首轮已获确认；现在 R1 spike/contract/parity，先交付最小真聊天；R2 优先近纯 stores 与 document ports；R3 完成最小真实阅读链后逐步接入 R4，
不先把所有面板铺满。R5 的 offline/quality 工作可独立分工，不阻塞普通原文查看。
“可分工”描述依赖，不授权自动启动多个 Agent 或绕过 review。

## 14. ADR 与文档权威

ADR-021 替代 DSH-first ownership；ADR-002/011–015/018/019 的领域不变量保留。其余 ADR 的 host-specific 部分按
[迁移表](migration/dsh-to-core.md) 和 ADR-021 解释，legacy runtime 继续遵循原契约。

R1 必须新签/补充：runtime/branch identity、durable submission、browser transport/replay/auth、native workspace
isolation、extension Web UI compatibility。R5 再签 provider generation/geometry 和模型增强边界。
不从“已经有目录”推断这些设计已全部冻结或实现。
其中独立 product-control v1 与内部持久信箱/checkpoint 的有限决定见 [ADR-024](adr/024-durable-product-submissions.md)；
它不冻结尚未实现的 HTTP/observation/approval/native isolation 合同。Flash raw/merge 的内部独立合同另见 ADR-026；增强/全质量仍待。

ADR-022 允许仅使用隔离的静态 Demo 验证交互，不提前冻结生产 PDF renderer、browser RPC、Memory 或 runtime
契约。Demo 的内存状态机和脚本答案不能迁名为生产协议/Agent Loop。
2026-09-08 用户已通过首轮交互评审；ADR-023 为后端工程提案，明确 gate 通过后再接受具体 contract/security 决定。

## 15. 测试与评测总计划

既有 schema/parser、SQLite、sidecar、DSH tools/projections、Reader/UI fixture、longitudinal tests 全部保留。
当前 D0 另外有 apps/web/test 的原型状态/quote/geometry tests，以及独立的 test:demo 浏览器 gate（真实 PDF、
本地文件不上传、认证静态资产、选区/笔记/偏好、取消、移动端与 axe）。这些不替代下面的正式产品测试。
新的测试层：

1. 原生 Pi vs DocAtlas-composed Pi：相同模型/工具/权限条件下的工具、资源、session、queue、compaction parity。
2. 生命周期：first-response 前 crash、异步持久化、重试/压缩、会话切换/rebind、迟到事件、单 writer。
3. 提交与副作用：所有入口、selection/queue、scope CAS、幂等、取消/unknown outcome、approval deadlines。
4. 真实 Web E2E：原始 PDF focus、selection、Compare、mixed code/data task、reload/断线、跨调查和版本。
5. 文档质量：section/page/block recall、citation precision/completeness、冲突/反证/abstention、OCR/visual/数字。
6. 研究连续性：旧工作检索与 reverify、stale propagation、循环自证/cross-scope leakage 目标为零。
7. 个性化：Probe 变量控制、why-used、纠正/遗忘、漂移/污染、time-to-evidence 与 factual non-regression。
8. Flash 对照：raw/merge/full vs legacy，ready latency、CPU/RSS、LLM cost、极端格式/资源约束。
9. 发布：frozen installs、source/contract compatibility、packaged artifacts、rollback/privacy/security/browser accessibility。

当前工具只使用固定 CPython 3.12.12/uv 0.9.21；历史多 Python 版本结果留在档案，不默默改变环境策略。
真实 Azure 请求 opt-in；faux-provider/lifecycle tests 不使用真实密钥或付费 token。SOTA/性能提升须有对照数据。

## 16. 安全、隐私与治理

- 文档/OCR/Note/Web/tool output 都是 data；不能提升为系统指令、权限或用户偏好。
- 先 authentication/workspace/source ACL，再 relevance；Bash/file tools 受实际进程/挂载隔离。
- runtime credentials 不进浏览器/Python/通用 shell 环境；不打印或持久化 Entra token。
- live observation 可丢弃/重建，重要 domain state 先 durable；不广播 raw source、base64 大结果或秘密。
- profiles 与 research 物理隔离；forget/deletion receipt 覆盖自有存储/WAL/backups，外部副本不假称已删。
- local/private first；引入 Cloud、网络写入、共享、长期记忆/高影响发布都有明确权限和可观察决策。
- Artifact/Note 不可循环支持祖先 Claim；模型 actor 不可冒充人类 sign-off；不因偏好改变事实门槛。

## 17. Source、升级与发布维护

sources.lock.json 固定 Pi release、DSH、DocAtlas、PageIndex 等；.sources 为只读研究输入，不是 product dependency。
verify_sources.sh 离线检查 origin/commit/detached/clean；check_source_updates.sh 看 main 差异但不自动升级 release。
Pi npm 接入在 R1 通过 pnpm 精确锁定，不能使用 checkout 中实验性源码入口。

DocAtlas-Harness 保持独立 Git、官方 origin、明确 downstream branch；不动 sibling 或通过 symlink 修改上游。
升级流程：read diff → ADR/contract impact → lock → compatibility/parity → document/Web/Memory gates → release notes。
回退不删除新数据，旧格式不可读时采用受检 export/restore；legacy DSH launcher 在产品 gate 通过前不切换。

## 18. 当前目录与演进

~~~text
apps/server/                 本机装配/HTTP认证、Read凭据/引用、研究/偏好/人类Review、隔离调度与clean恢复
apps/web/                    真实Pi live与独立原型；独立研究/偏好/Probe/审阅/Continuity已接，完整恢复/自动学习仍待
packages/core/               独立stores/document/selection/evidence/research与显式偏好应用；完整产品迁移继续
packages/runtime-pi/         公开Pi SDK、隔离worker/brokers/checkpoint、Azure Luna宿主模型适配
packages/runtime-document/   Node文档协调器、单文件PDF worker、资产/进程管理与sidecar适配
packages/reader/             解耦 Reader 状态/呈现（待提取）
packages/contracts/          已有 TS bindings，保留
contracts/                   已有 language-neutral schemas，保留
python/docatlas-sidecar/      已有 document service，保留
DocAtlas-Harness/             独立 writable downstream，保留
plugins/docatlas-dsh/         可构建的 legacy/reference adapter，原位保留
docs/{architecture,product,migration,adr,archive}/
research/                    全部研究与讨论，新增 Pi/Flash 分析
compat/pi/                   source baseline + parity/upgrade 说明
evals/pi-parity/              native/mixed-task 验收规格
.sources/pi/                 release-pinned upstream code，只读
~~~

R0 时的新目录为职责 README；D0 已让 apps/web 成为独立 prototype workspace package，并同步 pnpm lock、
typecheck/unit/build/browser checks。R1/R2之后已接Core/runtime-pi/runtime-document/server与真实live客户端，锁文件同步；
旧DSH入口保留wrapper/adapter。ADR-039/040提供本机beta API/server与启动入口，不等于公开生产部署；
未重命名根目录或移动用户数据。详见迁移清单、任务板与[本批记录](../research/34-product-citations-and-local-entry.md)。

## 19. 明确延后但保留方向

Cloud 与更多 OCR/layout/provider、Collection/Series 增强、Timeline/多媒体 Studio、team review/ACL/profile sync、
百万文档虚拟 tree、知识图谱数据库、fine-tuning/online RL、自动高影响 personalization、always-on monitoring。
必须有问题/数据/权限依据再扩大；不把尚未支持的能力从旧计划悄悄删除，也不伪装成首发已完成。

## 20. 下一可执行队列

首个本机阅读闭环已交付，下一队列以真实可操作的B层能力为主；详细接口/场景仍见
[后端设计 §11](architecture/backend-delivery.md#11-按可体验结果拆执行包)。已经完成的SDK/HTTP/引用实验不重复列为“下一步”。

1. R1/R6与R3引用归属：原生设置/历史分页（[ADR-048](adr/048-native-operations-and-history-pages.md)）、手动compact（[ADR-049](adr/049-manual-native-compaction.md)）、selected-head/navigation/fork与原Answer继承（[ADR-050](adr/050-native-lineage-handoffs.md)）均已有对应SDK/host/Web旅程，不再重复实现。继续自动in-turn压缩/steer的Read归属、完整native parity、资源/approval Web与扩展UI；已有分支handoff不等于异常host接管。保留新问题fresh Read与原证据不重标，不禁用Pi能力或移除fail-closed核验。
2. R4-004/005：显式controls/精确消费/MemoryUse、撤销与why-used、用户主动单变量Probe及ADR-054低频邀请/跨独立研究明确选择积累/独立确认已接；继续其他呈现轴、被动行为候选的专门授权/评审、漂移重学、真实模型on/off事实对照和纵向效果，不把选择/使用记录当作遵从或有效性证明。
3. R4-001：基础Record/Recall与ADR-052独立选区保存、自由Note/Question/Decision/Policy、完整版本和页Overlay已接，不重复实现。继续真实业务连续研究、未提交草稿/未知操作跨分支恢复、来源撤权与完整数据恢复验收；Policy自动应用需单独评审。旧Note/Question始终只作lead，重读原文后才能支持新事实。
4. R4-002/003：Claim/Review/本地Publish、显式版本/历史原件与选定旧记录的Continuity产品链已接；全检/browser结果见任务板，继续真实业务回归、完整impact发现和恢复。保留G0–G4、人类sign-off、原scope与重新准入边界，不为赶工自动学习或自动发布。
5. R3/R6：继续A/B、Notebook/偏好入口真实使用回归、资源/approval与混合计算/研究任务；修复试用阻塞，不改变居中聊天/原始PDF约定，不把已测子集称为完整parity。
6. R5/R7：中文FTS子串漏检和两类raw/merge空树已分别修复并通过同hash生成PDF对照；继续真实文档/OCR/geometry/Flash legacy与增强质量评估，不能把synthetic gate当全语料通过。并行推进异常退出恢复、迁移/备份/运维与正式发布。非阻塞Flash新选项不占阅读/研究主线。

用户已要求加速并行：Compare前端、研究Core/host桥接、偏好合同与回归可按互不重叠的文件责任拆分；
依赖或共享合同先对齐，生成物/构建由一个集成者收口，浏览器测试不与改写相同产物的构建并发。
每个工作包先定向检查，集成里程碑统一全检；已有通过的无关重型检查不反复运行来代替产品进展。
未冻结的字段仍需ADR/contract review，完整目标保持active，B/C未交付不能因本机beta可运行而标全部完成。

## 21. 仍需具体评审的决定

主方向已经由用户确认，不再反复讨论“插件还是产品”。有限的submission、HTTP/replay、worker边界、Flash作业、
selection、Answer、本机启动、独立人类研究/偏好、人类Review、显式版本/Continuity、单变量呈现学习、原生控制/历史/手动compact/分支及Flash局部优化已由ADR-024–052按各自范围落地；仍未决/未验收的是：
异常host退出后的安全接管、自动in-turn compaction/steer归属和完整native/extension Web compatibility、
旧DSH transcript/研究数据访问与迁移、geometry/真实语料质量、全面Continuity与研究/偏好恢复、自动校准阈值、
完整模型/资源/approval控制、团队/云与公开部署策略。

这些都有对应工作包，不能由文档或 scaffolding 静默变为已实现。

## 22. Definition of Done

用户能运行 DocAtlas-owned Web，并在完整 Pi 能力下：上传/选择资料、精确回原始 PDF、selection 追问、多文档
比较、原生编程/计算、可追踪推导、保存/继续旧研究、Review/Publish、受控个性化；取消/恢复/权限/版本变化
均诚实且可验证。代码、数据、产品三个迁移 gate 都通过；新用户不需理解 DSH/SourceScope 内部配置。

“目录存在”“旧 M0–M6 done”“若干百个测试通过”都不是完整产品完成的替代条件。

## 23. 讨论继承与证据追踪

| 研究输入 | 继续生效的内容 | 当前归属 |
|---|---|---|
| 01 DSH architecture / 05 roadmap | 生命周期、升级、契约和门控经验；DSH owner 已 superseded | R1/R7、archive |
| 02 PageIndex / 18 Flash adoption | provider、tree/content、bounded tools、geometry 边界、快速建树 | §8、R5 |
| 03/10/11 personalization | Core-owned、governed lifecycle、FTS/rules baseline、纵向评测 | §12、R4 |
| 04/06 commercial/08 product route | 主动阅读、来源、多文档、研究对象、Explore/Verify/Publish | §9、Web spec |
| 07 fact trace | Claim/Evidence/Derivation、反证/冲突、G0–G4、交互 checkpoint | §6/7/10、R4/R6 |
| 09 upstream DocAtlas / 12/13 Read | 原生实现边界、渐进读取/压测、legacy 安全与下游迁移 | §2/8、R2/R5 |
| 14 research continuity / 15 Note-Review-Memory | 研究积累与个性化正交、Probe、Tree overlays、应用场景 | §10–12、R4 |
| 16 Web full design | claim-span citation、原文/selection/multi-doc、重模块、失败/可访问性 | §9、Web spec；DSH布局已替代 |
| 17 Pi source audit | full SDK、时序/持久化/取消/rebind、原生能力保留与产品主权 | §3/5、R1/R6 |

[逐模块迁移表](migration/dsh-to-core.md) 连接现有源码与目标目录；旧规格中的未实现扩展仍可定位，不以重组为由丢失。
