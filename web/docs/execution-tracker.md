# DocAtlas 执行任务板

> Active · 2026-09-10 · [主计划 v1.9](implementation-plan.md)
> 已确认原型与真实本机 Pi Web beta 并存；后者已有启动入口/PDF引用闭环，尚非公网/全功能成品。旧 DSH 完成记录见 [归档](archive/dsh/execution-tracker-2026-09-01.md)。

## 状态说明

- done：本工作包产物与对应验证完成；文档 done 不意味着运行时代码 done。
- in-progress：正在实施的有界工作包。
- queued：依赖满足后执行。
- review-required：已有方向但具体契约/安全/数据行为未冻结。
- deferred：后续范围，仍有明确去向。

## 当前阶段

完整目标持续推进，未完成：内部 Pi/持久信箱/调度/隔离执行/HTTP认证/SSE/配对live已接；正常关闭后的原生恢复已测，异常退出完整恢复仍待。
上传→Library索引→明确revision→Pi Read/Flash→checkpoint、同版PDF原件与文字选区one-shot票据已接。
前批Flash summary/expand/full作业/只读overlay已接；本批接通host Read凭据→Pi checkpoint→Answer→原始PDF引用，并提供独立loopback启动入口与真实Azure模型。
真实Luna在3次调用内通过合成PDF引用smoke；网页完整定位/刷新/无未知引用按钮也已实测。不是全格式/真实语料质量或公开部署验收。
前批A/B原文对照/返回栈、Notebook与Pi Record/Recall、独立偏好控制已接。本批显式偏好接入host临时表达指导与实际生成MemoryUse；
Claim/Review已接产品HTTP/Web：canonical Evidence→Claim→Brief/Matrix→G0–G4→人工签署→本地不可变成果；
第十九批实际HTTP/Pi与新增browser旅程各1/1通过；身份race、审阅顺序及浏览器复验通过，JS全量发现的两处旧测试准备/同步问题已分别补验，Python872通过。其完整检查为分段记录，不写成整条脚本exit0。
第二十批接显式同文档revision、历史原始PDF和选定旧研究的Continuity：双侧新Read Evidence、固定旧记录版本、人类判断/原键对账，保持Pi来源准入与旧研究不变。两个新增实际Pi/PDF浏览器旅程通过；全量暴露的压力夹具/目录清单/页面同步问题已分别修复补验，准确分段结果见本批记录；完整研究/自动学习/Probe与恢复继续推进。
第二十一批接用户主动的同事实单轴Probe→原子选择/待确认候选→独立确认→现有偏好使用，并把Library原件/record回执/job成功同事务提交、补显式旧孤立回执修复。新增Probe及相关版本实际Pi/PDF网页旅程2/2通过；全检结果见本批记录。自动推断/触发、多轴与纵向效果仍未完成。
第二十二批接首问前原生设置/持久证明与真实历史分页。第二十三批并行完成手动compact/可证未应用/原键恢复/Web、host取消与真实进程join、Flash生成PDF质量gate及中文子串召回修复；整仓与最终定向/浏览器补验通过，精确范围见本批记录。
第二十四批并行完成实际Pi navigation/fork、selected-head/Catalog交接、历史原Answer/PDF、按需Web分支面板及HTTP/真实浏览器旅程；整仓全检与最后Stop绑定CAS的补验分列。Flash编号标题修复通过同hash配对/反例与原四类gate，不再将前批两类空树写成未修复。完整研究/真实语料/恢复/发布仍开放。
第二十五批接通独立人类四类研究、原PDF选区直接保存与只读页标记，原Notebook许可/票据保存保留为内入口；新保存不依赖提问、不执行Pi、不制造Evidence。原记录与完整命令回执同事务，v5→v6先备份；准确全检和并行浏览器结果见本批记录。PageIndex/SDK pins未变，发布版本/scope说明纠正，有界并行增强仍仅候选。
第二十六批已接显式v2并行Flash与同意后的低频邀请/跨独立研究偏好选择积累，四条相关Pi/PDF网页旅程通过，真实Azure Luna三调用引用smoke再次通过；原协议/旧回执保留。最终全仓与一小时交付的服务状态见本批末尾记录。
真实文档质量、原生parity、恢复/运维验收未过；不以内部fixture或faux模型宣称部署/质量成功。
完整待办仍含 R1–R7 与各自验收，不能用本轮局部测试把整个目标标完成。

## R0：本轮重组

| ID | 状态 | 产物 | 验证 |
|---|---|---|---|
| R0-001 | done | Pi v0.85.1 本地源码与 release commit pin | clone 到 .sources/pi；origin/detached/clean 由 source gate 复核 |
| R0-002 | done | SDK/loop/AgentSession/runtime replacement 源码分析 | research/17-pi-source-audit；事实与待验证假设分开 |
| R0-003 | done | ADR-021、Core/runtime/Web specs、旧模块全量继承表 | 不回到原版四 tool，不裁 Pi，重模块和 Web 规划保留 |
| R0-004 | done | 目录/导航/计划/任务板、旧档案与 workspace/source checks | 归档正文核对通过；33 文档/144 本地链接；旧 DSH checks 通过 |

## D0：原型先行

| ID | 状态 | 工作 | 验证/退出条件 |
|---|---|---|---|
| D0-001 | done | ADR-022、Prototype 01 规格与运行边界 | 真 PDF/模拟答案/未实现明确区分，旧领域计划不丢 |
| D0-002 | done | 居中聊天、样例问答/进度、真实引用打开原始 PDF | 原始 bytes hash、unique quote/real geometry、无 Markdown 替代 |
| D0-003 | done | 选区→context→追问、临时笔记与原文往返 | 一次性 context、显式 save、取消/迟到结果屏蔽 |
| D0-004 | done | 资料面板、本地 PDF、临时排版偏好 | 本地文件不上传/不套用示例答案；事实/引用不随排版改变 |
| D0-005 | done | authenticated static preview、响应式/可访问性、build/unit/browser regression | 14 个 Demo browser tests、401 JS + 76 Python、6 个旧 browser tests；详见记录 |
| D0-006 | done | 用户确认沿用现版原型设计 | 2026-09-08 明确确认；不再以首轮视觉评审阻塞后端 |
| D0-007 | queued | 后续多文档/旧研究/Claim/Review/Publish/个性化/通用任务原型 | 按场景展开重模块，不一次铺满首页 |
| D0-008 | done | 首个后端闭环范围明确：自有 PDF 真问答/原文引用/选区/恢复 | 限已确认主链；多文档/重模块仍由 D0-007 逐项评审 |

### 后端首个闭环的交接顺序

1. R1-001a/004a：公开 SDK 的首问/崩溃/settlement 与 worker/model/session/native I/O 隔离实验，再评审产品合同；不把 Demo 临时 state 当生产协议。
2. R1-002/003/005：嵌入原生 Pi，先证明无文档的普通任务、取消/恢复/单 writer、原生工具和可信资源不被裁剪。
3. R2-001/002/003：提取可复用 Core；统一上传/选择/@文档准入，五种 Read 与证据/选区身份；保持旧 DSH 构建回归。
4. R3-001/002/003：接通这版界面的“用户 PDF → 真实回答 → 原始 PDF 证据 → 选区追问”；错误/未就绪/重连必须可信。
5. 再逐项接入多文档、长期研究与个性化；D0-007 随相应模块评审，不要求先完成全景原型才启动底座。

这是下一阶段队列，不是本轮后端完成声明；模型测试仍显式 opt-in，不复用预设答案宣称真实运行成功。

## R1：完整 Pi 与产品运行合同（D0 评审后）

| ID | 状态 | 工作 | Exit / 依赖 |
|---|---|---|---|
| R1-001 | in-progress | product-control/product-http与observation v1；持久命令/快照/有界SSE | 内部隔离Pi HTTP闭环通过，完整approval/controls仍待 |
| R1-002 | in-progress | 公开 SDK 0.85.1 与 createPiRuntime 已实现；默认工具/资源、rebind 局部验证 | 完整 defaults/providers/parity 与产品集成仍待完成；R1-001 |
| R1-003 | in-progress | checkpoint/调度/heartbeat/队列/Stop、SSE、手动compact和navigation/fork已接 | 自动in-turn压缩/steer归属、更广retry与异常恢复；R1-002 |
| R1-004 | review-required | product auth、shell/filesystem/secret 隔离、extension UI 与统一 cancel | 无任意 path/跨 workspace/凭据泄露；Bash/Python/UI prompts 停止可证明 |
| R1-005 | in-progress | 原始 builtin metadata/schema/defaults 与原生 I/O 测例、24文件 patch gate | 仅内部已测子集；完整原生/混合任务/平台与资源 gate 未过 |

### R1 子包与首个实现任务

| 子包 | 状态 | 具体产物 | Exit |
|---|---|---|---|
| R1-design | done | backend-delivery v1、ADR-023 proposed、源码/依赖元数据复核、主计划 v0.6 | 工程候选/已实现/未决区分，D0 确认可追溯 |
| R1-001a | done | 公开依赖、9 lifecycle tests；实际子进程首问 crash、持久输入恢复/未知不重跑验证 | 仅 SDK/首问实验包；不等于全部 R1/parity 或硬件掉电保证 |
| R1-004a | in-progress | LinuxExecutor接native7/显式Bash/pi.exec；启动早停用已验证PID namespace终止 | 项目资源/package闭包、聚合资源/出口/后台任务仍待做 |
| R1-001b | in-progress | identity/submission/prepared/receipt/checkpoint/transition v1 + 控制库已实现；观察/审批待做 | ADR-024 限内部合同，auth/完整运行隔离仍 gated |
| R1-004b | in-progress | 独立Pi与brokers/checkpoint；resource-trust.v1审批、RO快照、撤销停止 | native7/PDF/cancel/crash/pi.exec/资源测试；auth、完整project-resource/controls/provider/额度仍待 |
| R1-004c | in-progress | Node各launcher共用PID guard；Python PDF/Flash pidfd，保留mount/seccomp/资源限制 | 启动/撤销/立即停止与算法等价；host death/cgroup/跨平台仍待 |

R1-001a/004a 是同一个有界技术验证工作包的两个关注面，不要求预先完成全部产品代码。
已安装 SDK 并运行真实 Pi + faux provider，不调用 Azure。源码审计/局部测试/正式集成状态仍分别记录。
第二批证明见 [持久信箱实验](../research/20-durable-inbox-and-flash-probe.md)：首问数据可恢复不等于执行副作用能自动恢复；
epoch 过期不等于进程退出，恢复接口调用方必须先确认执行进程停止。
第三批见 [原生调度记录](../research/21-native-dispatch-and-io.md) / [ADR-025](adr/025-native-io-and-submission-dispatch.md)。
新增内部Prepare port，document-free 实现拒绝文档引用；不能当作完整文档准入。SDK接受却未消费的故障停止后标unknown，不重放。

## R2：已有 Core 提取与 document bridge

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R2-001 | in-progress | 首批stores、Library/Scope、Answer编译器及Pi checkpoint绑定已接；Node discovery/assets/supervisor独立；DSH薄adapter | 其余研究模块/数据migration与完整语料验收继续 |
| R2-002 | in-progress | Library/上传/文字selection ticket准入+prepare/consume快照与owner/generation/hash/policy检查 | pin/region selection、Answer/Evidence与全部UI入口仍待 |
| R2-003 | in-progress | uv Node/DSH ports、Pi sources/search/read/tree/enrichment及Record/Recall；真实PDF/图片与checkpoint | 五mode Read/取消/正常恢复及基础研究桥接已测；完整研究/隔离验收继续 |
| R2-004 | queued | 提取基线/样本数据 migration 与 backup/restore | ID/hash/schema/旧 provenance 不丢；不搬生产 DB；R2-001 |

R2 首批实现为 source-scope-store、M4、Continuity store/service、Personalization store，共 9,465 行；移动时 5 个源码
SHA 完全相同，见 [提取记录](../research/19-backend-runtime-spike.md)。5 个纯模块测试移到 Core，旧 plugin 集成测试保留。

## R3：真实 Web 阅读主流程

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R3-001 | in-progress | 本机真实launcher、创建/命令/观察、原键重试与clean-restart原生恢复已接 | 异常退出监督/核验、完整原生管理与公网部署仍待；R1/R2 |
| R3-002 | in-progress | live上传/Library/显式同文档revision更新、历史分页与双版本选择已接；@PDF/删除管理待接 | CAS/不可变bytes/旧原件/只读status已接；domain+job原子成功及旧receipt显式修复已测，全入口/完整恢复待验 |
| R3-003 | in-progress | host-attested Answer→同版原件/unique quote、A/B返回栈；native历史origin保持原manifest/证据不重标 | navigation/fork的真实PDF browser通过；全格式geometry、自动compaction/steer归属与真实语料仍待 |
| R3-004 | in-progress | 文字selection one-shot/all-or-none；A/B独立版本/页/zoom/scroll/选区与窄屏切换已接 | pin/region、完整资料组织与真实业务验收仍待 |
| R3-005 | in-progress | chat-first居中真实入口、按需历史/原件与新增browser回归；其余视觉/真实PDF矩阵继续 | 本机beta可试；全面旅程/视觉/语料验收未完成 |

## R4：研究与个性化重模块（不丢弃）

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R4-001 | in-progress | 独立人类Note/Question/Decision/Policy、PDF直接保存/全文CAS/生命周期/精确页Overlay、Pi Record/Recall与跨会话研究已接 | 本批有界集成见验证记录；完整研究/草稿/异常恢复与真实业务仍待，Policy不自动应用 |
| R4-002 | in-progress | 六个人类product-review命令、原Evidence/历史scope工作面、CAS/G0–G4/独立签署与Brief/Matrix本地发布已接 | actual HTTP/Pi/browser、身份race及本批全量相关用例通过；真实业务/完整恢复仍待；不把规则检查当算术或语义证明 |
| R4-003 | in-progress | 旧记录完整依赖/原权限、显式版本impact与人类Continuity工作面已接，固定record version/整body幂等 | 两个新增实际Pi/PDF browser旅程通过；原权限/版本/截断/幂等回归通过；完整业务/impact发现/恢复仍待 |
| R4-004 | in-progress | 显式controls/实际生成MemoryUse/单票候选与ADR-054跨独立研究的明确选择积累/独立确认已接 | 新真实Pi/PDF journey通过；被动习惯推断/Reader适配、真实模型on/off事实与纵向效果、完整隐私/恢复验收仍待 |
| R4-005 | in-progress | 单变量完整Answer Probe、独立default-off低频邀请/统一slot/cooldown/跨研究去重与反向票保留已接 | 新旧Pi/PDF旅程通过；其他轴/漂移重学/纵向效用继续 |

R4-003审计的三处代码缺口已在第二十批实现：canonical Answer/完整derived closure及原publication授权、显式revision关联合同与事务CAS、历史原件授权。第二十一批收口domain版本与job成功同事务及完整原receipt显式修复；不能据此代替完整真实业务/host故障/硬件掉电/恢复验收。

## R5：Flash 与文档处理演进

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R5-001 | in-progress | immutable raw-merge/显式增强、ADR-053显式v2双路frontier/DAG/整job预留/全部provider join已接，旧任务保留v1 | 实际host/PDF与新Web通过，全量见本批记录；全平台/unclean恢复/失败用量与质量仍待 |
| R5-002 | in-progress | Flash Pi tree与只读enrichment导航、Library增强drawer已接；原文FTS不覆盖 | 默认选择/完整fallback及真实模型检索质量待做 |
| R5-003 | in-progress | raw/merge/65页与四类真实生成PDFgate；中文0/80→80/80，编号标题受检补丁修复重复模板空树 | 同hash2×2及11项配对/反例、原4类gate通过；legacy/full/真实语料/OCR/复杂长文/模型质量仍待 |
| R5-004 | queued | 可信 geometry 输出/rotation/重复文字/原页校验研究 | 明确 internal API 风险，contract + no-wrong-highlight tests |

R5 source-update 已完成：PageIndex main ae16956 / JS SDK 9925e8a 在线复核；Python source pin/checkout 已更新。
Flash 目录与旧 pin 无差异；新 SDK stream/error/multimodal/base64-display 能力见 research/18。raw/merge provider及显式summary/expand/full预算作业已内接，
完整增强/书签融合质量、长文/中文/OCR与异常恢复仍待验收，没有因更新pin就标成完成。
第二十五批线上复核仍无新main升级；Python稳定0.2.15已经包含于现有pin，JS发布0.8.0较审计main旧。纠正源码占位版本和SDK scope可当ACL的误读，细节见[research/38](../research/38-pageindex-sdk-followup.md)。独立frontier/summary DAG有界并行、整job在途预算与真实provider join仅待评审，不作为已实现优化。

## R6：通用能力与混合任务

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R6-001 | in-progress | model/thinking/双queue/真实历史/手动compact；ADR-050实际selected-head/navigation/fork与代际交接 | 分支SDK/host/HTTP/Web、冷原键恢复、原PDF及真实Stop通过；自动in-turn compact/steer出处、完整扩展UI与parity仍待 |
| R6-002 | in-progress | 已验真实PDF→原生write/Bash/Node/read→CSV/SVG/Markdown/可复跑代码与输入→原引用；取消资料选择后通用计算继续 | 仅scripted-provider混合基线，未自动登记derived Evidence/Excel workbook/正式成果发布；真实模型业务验收继续；R3/R4 |
| R6-003 | queued | 论文/规范→编程/实验→Note/研究连续性 | 无文档任务不受 scope 锁死，混合任务不丢能力 |
| R6-004 | review-required | 受管后台模型作业/子 Agent/MCP 等扩展 | 显式 parent/scope/budget/cancel/accounting；并非全部 Pi 内置 |

## R7：发布、迁移和运维

| ID | 状态 | 工作 | Exit |
|---|---|---|---|
| R7-001 | queued | DSH 历史 provenance/数据访问与 backup-first 迁移 | 复制样本先行；旧 journal/blob/profile/session 不破坏 |
| R7-002 | queued | 冷恢复/升级/rollback、native 权限、privacy/source/cross-workspace gate | 故障注入/权限撤销/不重复副作用 |
| R7-003 | queued | 真实用户 Web + mixed-task + Memory/Flash acceptance | R1–R6 首发 gate；有数据，不凭测试数宣布可用 |
| R7-004 | in-progress | 独立loopback beta launcher/使用指南已接；正式deployment/runbook与DSH回退策略待做 | 正式默认切换须完成此前gates；旧DSH命令继续保留 |

R8 deferred：Cloud/OCR provider 扩展、Collection/Series 增强、Timeline/更多 Studio、team review/profile sync/ACL。
详细需求保留在主计划/Web spec/历史调研，不用“后续”掩盖缺失。

## 验证记录

### 2026-09-11 · 即时发送反馈（ADR-063，验收范围如下）

- 定位到旧UI等待run记录才画问题、accept先清draft再等snapshot补正文的两个空档。新增仅内存`outgoing`投影：在原请求冻结/持久outbox之后立即可视，绑定同一binding/generation/requestHash，accept与SSE先到保留本地正文，权威run正文/checkpoint/purge或换binding后撤下。不会写第二份transcript，也不会按文本相等去重。
- 正常发送期间输入视觉清空并保持原body/key/source/selection，结果未知后仍显示原文并可原键重试。避免正常发送时闪现大型outbox提示；发送气泡轻量进场，缩放输入后再跟随滚动。首次无会话仍先创建真实会话，不声称伪造native历史或加快模型本身。
- 定向`apps/web/test/live-client.spec.ts`与`apps/web/test/research-visualization.spec.ts` **2文件16项通过**：同步冻结/连按/禁止覆盖、POST与SSE两种先后、snapshot正文尚空、同文不同请求、换binding/purge；源码与e2e类型、lint通过。新增浏览器`send-feedback.pw.ts`在**1440/390px两项通过**：网络被暂停时在1秒断言内显示气泡、输入视觉清空、连续Enter仅一个原键、Shift+Enter/组合输入不发送、同文两次提交与刷新不重发；确认前后气泡clientWidth/clientHeight差≤2px。
- 和ADR-062合并的`bash scripts/check.sh` **exit0**，日志`/tmp/docatlas-adr062-063-final-check.log`：**221 JS文件，2910通过、1既有跳过；1469 Python通过**；环境/生成物/lint/build/types/plugin/compat/protocol/ruff/format/mypy/Flash来源与packed均通过。之后仅将发送状态移到消息间距、补尺寸断言与旧浏览器初始化等待修复，补跑Web构建、e2e类型、lint及下述浏览器；未把早期失败脚本冒称为成功。
- 最终Web构建：`bash scripts/pnpmw --filter @docatlas/web-demo build`（日志`/tmp/docatlas-final-web.log`）；最后`bash scripts/pnpmw exec tsc --project tsconfig.e2e.json --noEmit`和`bash scripts/pnpmw run lint`通过。没有对真实工作区发起测试问答或更改其资料。

### 2026-09-11 · 研究工作面与地图叠加、回答面板简化（ADR-062，验收范围如下）

- Notes/Review从More移到桌面直接入口与手机Research菜单；复用原控制器/原键待办，Notes采用列表/全文分栏，Review新增真实保存关系图与G0–G4覆盖状态。Map研究层从已有记录重建：新增青绿、修订琥珀，支持原文与真实记录回跳，删除撤回标记，原树不变。
- 新增可选`HumanResearchOverlay.recordVersions`和`ProductReviewWorkspace.scopeOptions.sourceRefs`，明确完整/有界元数据，不迁移store、不授予Pi新来源。共享wire反例覆盖错误版本/作者、跨记录元数据、来源漏项/重复/私有路径；投影覆盖同页不等跨度兄弟节点、精确版本/representation、页码、60节点上限和Review journal顺序。
- 源码路径定向：`vitest run --config .cache/adr061-vitest.config.ts apps/web/test/research-visualization.spec.ts apps/web/test/document-map.spec.ts apps/server/test/human-research.spec.ts packages/contracts/test/human-research-contracts.spec.ts packages/contracts/test/product-review.spec.ts` **5文件219项通过**。新增fixture首轮字符计数不一致导致1项失败，修正fixture为真实preview字符数后通过。
- 按用户要求在研究实现之后删除About these sources、Answer options、重复免责声明和独立LiveProbe挂载，不另造替代标签；无效引用仍禁用，PDF核对/历史来源提示保留。Review使用独立入口，不随回答菜单移除。旧Probe UI旅程显式退役，底层合同/outbox/HTTP及独立learning仍测，回答旅程验证入口缺席。
- 首次源码typecheck通过；lint发现多余对象展开，已改。删除UI后旧断言仍检查已移除的提示文字，已更新为无面板且引用tooltip仍在，而非放松原文/权限断言。
- 首次全量`bash scripts/check.sh`运行日志：`/tmp/docatlas-adr062-check.log`（失败及最终复核见上下文）。重启前确认两会话全部completed、0 live、无preparing/generating增强；PID101067正常SIGINT/join，构建后恢复同一`.cache/product`。运行服务ready、无需登录、跨Origin API403；未在真实工作区上传、发问或生成摘要。
- 上述首次全检停在JS：**219文件通过、2文件失败；2903通过、3失败、1既有跳过**。3个失败均为已退役说明面板的旧断言；改为检查正文/合同warning完整、无冗余panel后，`research-visualization / answer-markdown / probe / live-answers` **4文件33项通过**，未弱化证据或来源校验。
- 第一浏览器组合2/4通过：两条原PDF/Markdown/上标引用通过；新map用例把cold tree当5秒DOM等待，结束时中断尚在运行的请求；统一现有cold-tree 30秒等待。另一失败是测试导航助手在reload尚未挂载入口时误判为手机菜单，改为等待真实入口挂载，不改产品授权。
- 第二次Map停在合成选区动作：关闭地图动画尚未完成，测试就在仍inert的PDF背景选字，补等真实dialog关闭。随后实际笔记保存与Review人工声明/批准/拒绝/发布走通，axe指出所选笔记/选区小字对比度4.46–4.47及旧Drawer重复banner。提高工作面/选区字色对比度，Drawer标题改普通容器并保留真实h2与对话框标识；最终浏览器复核结果如下。
- 最终组合命令：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/research-map.pw.ts e2e/live/reviews.pw.ts e2e/live/send-feedback.pw.ts e2e/live/reading-context.pw.ts e2e/live/human-research.pw.ts e2e/live/document-map.pw.ts e2e/live/answers.pw.ts e2e/live/compare.pw.ts --output .cache/playwright-adr062-063-final`。日志`/tmp/docatlas-adr062-063-final-browser.log`：**15通过、1失败**（11分钟）。失败是旧human-research初始化在立即reload时捕获上一导航的已中断response并等待`finished()`，页面本身已ready，尚未执行笔记步骤。
- 改为导航前观察本次snapshot并解析真实完整JSON，不立即reload或等待已取消的response。`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/human-research.pw.ts --output .cache/playwright-adr062-human-final` **2/2通过**（1.1分钟，日志`/tmp/docatlas-adr062-human-final.log`）。合并复核为**16个不同场景全部通过**，不将重复项计成新增场景，也不把15/16首轮说成exit0。
- 覆盖：原件引用/上标/Markdown、独立A/B、地图层级与缓存/错源/迟到/reduced-motion、独立四类人类研究及完整版本/原键/软删除、选区Ask与Note分离/跨会话原件/Recall线索、章节摘要显式确认与原键恢复、原始选区在问答/刷新中保留、研究地图新增青绿→v2琥珀→v3删除撤下/原结构不变/真实PDF精确高亮、Review真实关系图/人工批准拒绝/发布、桌面与390px发送反馈。包含新增工作面、地图和选区的axe检查，未屏蔽规则。
- 最终同一`.cache/product`服务PID2201310，入口`http://127.0.0.1:4177/`。每次构建前均确认空闲、核验精确pid/cwd/cmd、SIGINT并等待正常关闭；最后空闲核对为两会话4/12个completed、无live/运行中增强。`bash scripts/pnpmw exec node scripts/check-docatlas-running.mjs`通过：ready、同一真实入口/脚本、无登录、跨Origin API403。未发送真实模型请求、上传fixture或清除用户研究。

### 2026-09-11 · 地图摘要与选区问答上下文（ADR-061，随后追加ADR-062）

- 地图只在canonical tree外附带有界summary previews，完整摘要验证同版source/generation/tree/node/resultHash；显式确认后复用既有v2 Flash作业，掉线恢复使用原请求/原键，读取地图不启动模型。显示生成摘要/原文摘录，过大章节不冒充完整摘要。
- 新question-context只读协议从ControlStore、既有SelectionTickets和被核验native origins/checkpoint/publication投影。问题与回答展示同一原始选区，支持刷新、展开、原PDF高亮回跳与手机/双语；不写第二份对话/Note/Evidence。已消费ticket可历史阅读；清除原提交、撤权、换源或错关联时不复活内容。
- 不改在线lib/dist的源码路径临时typecheck通过；5文件**28项**定向通过。第一次测试中“改成f… hash”的反例碰巧与fixture原hash相同，改为确定不同的hash后通过，未放宽实现检查。临时配置位于`.cache/adr061-typecheck.json`和`.cache/adr061-vitest.config.ts`。
- `bash scripts/check.sh`日志`/tmp/docatlas-reading-context-check.TpRegB.log`：环境/生成/lint/build/types/plugin/compat/protocol/ruff/format/mypy通过；**220 JS文件，2893通过、1既有跳过**；Python **1460通过、1失败**，仅因新question-context尚未加入schema catalog完整性测试的显式期望集合。补上新合同后，`uv run --locked --project python/docatlas-sidecar pytest python/docatlas-sidecar/tests/test_m0_contracts.py python/docatlas-sidecar/tests/test_question_context_contract.py` **43通过**；Flash源与packed检查通过。不声称整条首轮脚本exit0。
- `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/reading-context.pw.ts --output .cache/playwright-reading-context-first` **2/2通过**（1.2分钟）：真实PDF六行选区在问题/回答/刷新后保留，原件精确高亮并返回消息，中文/390px及axe；章节摘要确认、accept回执丢失、关图重开原键恢复、结果预览/完整文本、刷新后只读复用，模型次数不增加。截图仅含独立测试fixture。
- 重启前只读核对2个会话（2及12个completed运行，0 live/运行中工具）和增强状态（1个既有failed，无preparing/generating）；精确PID2668864的cwd/cmd核验后SIGINT正常关闭并join。构建后恢复同一`.cache/product`，当前服务PID101067；健康ready、本机无需登录、跨Origin API403。未对真实工作区发送问题、上传材料或启动摘要作业。
- 用户随后追加Note/Review/Tree Update可视化；按research/15与ADR-012制定ADR-062并继续实施。这部分不能以已有底层/本文记录冒充已交付。

### 2026-09-11 · 原PDF下方重复文字修复（ADR-058补充）

- 用户要求Reader不显示Markdown。核对发现并非额外MD模块，而是连续Reader仅给当前页添加`pdf-text-layer`，共享CSS漏掉相邻页的`pdf-page-text`，使PDF.js文本变为可见普通文字。统一两类文字层的透明、定位、裁剪、缩放及选区样式；不删除PDF文字层、不改选区/引用接口、不影响聊天回答的Markdown排版。
- 新增真实浏览器计算样式断言，逐页检查透明字色、绝对定位、裁剪、叠放、页面尺寸与可选中属性，覆盖初始相邻页、跨页后原当前页、页码跳转、缩放、中文及390px；Reader内无Markdown/pre正文。修复前同一用例明确在第2页失败（overlay layout、visible or unselectable text），结果`.cache/playwright-pdf-overlay-before/`。
- 首轮组合浏览器9/11通过：新建会话用例的POST为201，但snapshot在5s阈值内未返回；另一个是新增断言在切换中文后仍用英文Reader名称查找，已修正为两种精确名称，未放宽样式断言或超时。
- 最终独立运行`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/reading-experience.pw.ts e2e/live/answers.pw.ts e2e/live/selections.pw.ts e2e/live/ask-selection.pw.ts e2e/live/compare.pw.ts --output .cache/playwright-pdf-overlay-isolated`：**11/11通过**（3.4分钟）。覆盖当前及相邻页透明/定位/裁剪、跨页/缩放/中文/390px、真实Read引用与上标高亮、选区附入/恢复/消费/迟到会话隔离和A/B对照。此结果是前一轮同组复核，不将两轮通过数累加为独立场景。
- `bash scripts/check.sh`首轮日志`/tmp/docatlas-pdf-overlay-check.UjvMnE.log`：环境、生成、lint、build、types通过；JS **213文件通过、3文件失败，2868通过、3项5s超时、1既有跳过**。失败在未修改的canonical-evidence、human-research-store及product-reviews，全部明确为test timeout；当时浏览器与4-worker JS并行。本轮不把超时归因当作已证明，不增加阈值、不跳过测试；停止重叠运行后单worker复核这3个完整文件，再顺序补跑check.sh后续检查。
- 后续顺序验证日志`/tmp/docatlas-pdf-overlay-followup.aPj5WA.log` **exit0**：`bash scripts/pnpmw exec vitest run packages/core/test/canonical-evidence.spec.ts packages/core/test/human-research-store.spec.ts apps/server/test/product-reviews.spec.ts --maxWorkers=1` **3文件57项通过**；最终e2e测试文件oxlint、`tsc --project tsconfig.e2e.json --noEmit`通过；`check:plugin`、`check:compat`、`check:protocol`及uv locked的ruff/format/mypy、**1450 Python**、Flash源与packed检查全部通过。这是分段完成，不声称整条check.sh首轮exit0；没有重建正在被测试读取的lib/dist或再次重启已恢复的服务。
- 4177旧服务核对2个会话均无活动任务，精确PID/cwd核验后SIGINT正常退出并join；构建完成后恢复同一`.cache/product`，本次PID2668864。健康`ready:true/loginRequired:false/crossOriginApi:403`。只读实际浏览器检查已有回答的原PDF，第1/2页共225个文字span均透明、绝对定位且可选择，原引用精确高亮1处、Reader内Markdown为0、无pageerror。没有发送问题、调用Azure模型、上传测试材料或改动用户文档/记录。

### 2026-09-11 · 文档地图与交互精修（ADR-060）

- 本轮按frontend-design与ui-ux-pro-max的设计流程重读主文档/quick-reference/pro-rules并检索层级与交互。未照搬营销页、Treemap或因果分解：目录是导航关系，采用真实父子连线的地图、可访问大纲替代、分支辅助配色与页码分布。保留白底聊天和默认英文；没有安装新全局skill或引入可视化/动画依赖。
- 新增Reader工具栏Map/地图入口和目录侧栏“探索文档地图”。按需加载独立全屏工作面，包含平移/缩放/适合画布、分支展开/折叠与聚焦、搜索、大纲、章节路径/详情、页码分布和“阅读这一节”。只导航同版原PDF，不生成Evidence、不调用问答或增强模型。
- 图节点≤180、深度≤7，大纲≤2000、每批≤200，循环/缺失父节点与显示裁剪有明确提示；记录不变，不造关系或因果。两种导航共用当前Reader内的只读目录结果，重复打开不重新加载；doc/revision/sourceHash/pageCount/mode/treeHash/generation/分页校验与source切换序号隔离迟到响应。
- Chat对PDF视口offset使用独立shell快照，240次连续offset更新保持Chat快照引用不变，Reader仍保留每个新offset，返回使用最新位置。用户交互序号照常更新，未削弱迟到导航保护。长问题默认六行可展开，原问题完整保留并按原文送入Pi；气泡/输入框/次级色块更紧凑，面板进入/离开、缩放与按钮反馈统一且可中断。
- 静态HTML有真实加载占位，轻量启动模块先加载，主应用延后加载；DocumentMap模块约14.8kB原始/~5.5kB gzip，仅第一次打开地图加载。只对已命中静态白名单且内容指纹命名的JS/CSS/字体设置immutable浏览器缓存。HTML、API、PDF、非指纹路径保持no-store；不声称主应用全部3.8MB解析代码已经消失。
- 定向 **4文件28项**通过：真实父子关系/不重叠布局、展开/聚焦/循环/深度/数量边界、来源与分页错配、长问题完整转义、视口隔离/准确返回，以及静态编码与仅公共资源缓存策略。Web/e2e types与oxlint通过。
- 预览第一轮地图浏览器发现装饰性页码条的aria-label不适用，改为aria-hidden而非禁用axe；第二轮11条中10通过，剩一项为移动端选中行页码对比度4.34，已调整到更深前景。随后最终地图/聊天/阅读 **11条全部通过**，目录共享、真实嵌套PDF、迟到跨source、错误来源、长问题与加载shell、375/390/横屏、axe与reduced-motion路径通过。截图在`.cache/playwright-document-map-final/`，图像工具不支持呈现，未声称人工目检。
- 整仓`bash scripts/check.sh`运行记录`/tmp/docatlas-document-map-check.YMUkfx.log` **exit0**：环境/生成/lint/build/types及**216文件2871 JS通过、1既有跳过**；plugin/compat/protocol、uv locked ruff/format/mypy、**1450 Python**与Flash源/打包核验全部通过。portal中加载圆点的独立reduced-motion覆盖及大纲离屏content-visibility样式已补充；全量JS及浏览器均结束后正常停止服务，`vite build` Web增量构建日志`/tmp/docatlas-document-map-final-web.UvgRMg.log` **exit0**，未重建正在被检查的Core/Python产物。最终 `playwright test --config playwright.live.config.ts e2e/live/document-map.pw.ts --output .cache/playwright-document-map-css-final` **5通过**，包括加载中的portal圆点动画确认为none、地图全流程/页面复用/错源/跨source迟到/长问题/375及横屏；此前聊天与阅读11通过。两轮结果分别记录，不冒充16个互不重复场景。
- 旧服务无任务时正常关闭并join，完整build/types结束后才恢复4177同一`.cache/product`（本次PID1315054）；文件/历史不改。健康ready:true、crossOriginApi:403。首次压力期实际问答输入就绪诊断触发5s上限，随后授权snapshot 200/133ms，尚不能据此宣称端到端首问加速，待空闲补测公共资源缓存。
- 后续实际页面只读补测：首次本机输入就绪716ms、JS网络传输381560字节；同一浏览器再次打开293ms、6个JS资源transferSize均为0。该结果证明公共资源复用，不证明所有设备/网络下均为同一耗时，也不能与早先不同压力条件的562ms直接作首屏加速比例。
- 最终CSS构建后恢复同一4177与原状态目录，本次启动PID1489949；健康检查ready:true、loginRequired:false、crossOriginApi:403。没有替用户上传测试资料、创建私人选区、发问或调用Azure模型。

### 2026-09-11 · 修复Ask选区未真正附入问题（ADR-059）

- 只读核对用户当前提交：最近“翻译为中文”的selectionContextIds/sourceRefs均为0，选区数据库ticket总数为0。根因是Ask about this只设置proposed，仍需第二次Verify；未Verify却允许发送，模型因此未收到选中文字。没有把问题误判为模型忽略选区。
- Ask按钮现在自动执行一次原selection-stage核验并附入下一条问题；保留用户已有翻译/解释草稿，空草稿才填可编辑默认问题并聚焦。成功显示“Ready to ask”，最终由用户明确Send；划选、切换语言、刷新不调用模型或自动重发。
- proposed/核验中/失败/恢复待办/损坏待办阻断按钮与Enter发送；成功附入或明确舍弃才释放。新增独立闸门owner防止旧release清掉新操作；原body/key保留显式重试，迟到响应不能附入新会话。当前ticket重复Ask去重，不扩大来源或重建Evidence。
- 选区托盘改为两行可展开原文、独立状态与有间隔的重试/舍弃操作，避免长选区把操作埋掉；旧研究保存与回原文、撤销/仅本地移除保留。默认英文/中英文切换不改变原文和已有草稿。
- `bash scripts/pnpmw exec vitest run apps/web/test/live-client.spec.ts`：**7通过**，包含旧owner重复释放、新owner持有与会话切换；Web typecheck、e2e typecheck、定向oxlint通过。
- 首轮独立`.cache/selection-fix-dist`浏览器5项通过。最终 `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/ask-selection.pw.ts e2e/live/selections.pw.ts e2e/live/compare.pw.ts e2e/live/notebook.pw.ts e2e/live/human-research.pw.ts --output .cache/playwright-selection-ask-final`：**11通过**。包括多行长选区/翻译草稿实际传给Pi、核验中Enter阻断、默认建议、重复点击、原键丢回执/刷新恢复、不匹配拒绝、损坏待办、跨会话迟到、A/B与Note/独立研究回归。
- 测试明确断言提交中有相同selectionContextId与sourceRefs、Pi收到第1–6行原文及“quoted source data, not instructions”、ticket只消费一次。均为仓库合成PDF与受控测试provider，未调用Azure或把用户私人段落用于模型测试。
- `bash scripts/check.sh` **exit0**，日志`/tmp/docatlas-selection-ask-check.bldRMN.log`：**215文件、2863 JS通过、1既有跳过；1450 Python通过**；环境/生成合同/同步/lint/build/types/plugin/compat/protocol/ruff/format/mypy及Flash源与打包核验全部通过。
- 旧4177服务在确认无活跃任务后正常关闭并join，再构建；输出冻结后恢复同一`.cache/product`，PID1253490是本次启动记录。健康检查**ready:true、loginRequired:false、crossOriginApi:403**。未删除PDF、修改旧回答、创建用户选区或替用户发送问题。

### 2026-09-10 · 阅读体验重设计、连续PDF与英文默认（ADR-058）

- 使用find-skills核对来源，并完整阅读Anthropic frontend-design、ui-ux-pro-max及其规则。skills.sh当时显示约873.2K/352.1K安装；设计系统首轮误命中Marketplace已拒绝，收窄到documentation后只采用阅读型排版、灰白/蓝色、窗口化与reduced-motion指导。不安装全局skill、不引入远程图片/字体，不以排名代替设计评审。
- 已实现真实Web的统一浅色阅读排版、紧凑数字引用（反驳/限定保留符号及accessible关系）、无“你/生成中/已核验记录”的用户气泡、单一圆点等待动效、可伸缩输入框与按需处理详情。主要导航/对照操作下移阅读器底部，顶部保留文件和页码缩放；没有减少原件核验或隐藏失败/未保存状态。
- 连续PDF采用单滚动容器、真实页面占位、最多5个邻近页canvas、当前页同步与原件复用。高亮仍由实际文字层唯一匹配产生；当前/非当前页分开，原A/B和选区授权保留。已保存Answer的Markdown渲染缓存，不随每次PDF滚动重新解析。原型仍保留独立单页Reader。
- 文档目录读取已有授权Flash merge接口，校对doc/revision/original hash/tree generation/tree hash/分页，支持层级折叠、查找、当前章节和点击跳页。空树/不可用诚实提示；目录不是Evidence，不调用模型，不改变提问来源。新浏览器测试证明目录导航的问答和增强model调用均为0。
- 主流程首次默认英文，EN/中文切换仅保存本机UI语言，刷新保留；草稿、原文、已保存回答、PDF页码与缩放不重置、不翻译、不重发问题。旧研究/治理面板内部仍有中文长说明；目前只覆盖其入口与主标题，不称全站翻译完成。
- 原件保持完整长度/哈希检查。服务仅对固定白名单公共JS/CSS增加启动时Brotli/Gzip，遵守编码质量及q=0，保留Vary/精确长度和64MB启动内存预算；PDF/API正文不经过压缩路径。
- 首轮定向6文件 **48测试通过**，涵盖长文档窗口/混合比例/树折叠与循环/语言默认与存储失败/独立cursor/编码往返与拒绝、以及既有引用与Probe语义。
- 浏览器预验先4条引用/上标/对照/选区通过。新English旅程先发现测试fixture未配置只读tree所属的enrichment服务（503），显式装配空答案测试provider并验证0调用；再发现窄屏仅Reader显示时缺少main/h1 landmark，已修复而非禁用axe。
- 最终 `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/reading-experience.pw.ts e2e/live/simple-entry.pw.ts e2e/live/answers.pw.ts e2e/live/compare.pw.ts e2e/live/selections.pw.ts e2e/live/chat.pw.ts --output .cache/playwright-reading-design-final`：**15通过**。覆盖英文默认/语言切换/刷新/不重放、真实原件连续滚动/第6页/缩放/目录跳页、A/B/选区/引用、上传/创建回执丢失、停止、390px及axe/reduced-motion。旧旅程通过显式zh测试fixture运行，不改变产品en默认。
- 实际4177页面另做只读检查：默认en、引用文本为`1`、同版原PDF精确高亮、当前窗口2个canvas、语言切换不重新请求PDF、390px无横向溢出。截图`.cache/reader-design-after-desktop.png`和`reader-design-after-mobile.png`；图像工具无法呈现，未声称人工目检。未对用户会话发送额外问题或调用Azure模型。
- 实际主脚本传输由3779096降为323582字节（约减少91%）；同次引用到高亮5046ms，其中服务端响应3907ms，Reader记录目标页首绘614ms。入口在并行压力检查中4188ms，不能与早先闲时778ms直接比较并声称全面变快。服务端引用启动/核验仍是后续性能重点，未用跳过核验或延迟假高亮替代。
- `bash scripts/check.sh`日志`/tmp/docatlas-reading-design-check.Cwoqxk.log`：环境/生成合同/同步/lint/build/types通过；首轮并发JS **207文件通过、8文件超时；2851通过、11超时、1既有跳过**，11项均为原5000ms截止，不是断言不一致。未放宽超时或改产品代码；同8文件 `vitest run --maxWorkers=1` 复验 **79通过**，日志`/tmp/docatlas-reading-design-recheck.BS8is9.log`，其余207文件原样通过。此为分段复验，不写成check.sh exit0。
- 余下plugin/compat/protocol、uv locked的ruff/format/mypy、**1450 Python测试**、源与packed Flash闸门全部通过，日志`/tmp/docatlas-reading-design-remaining.JMt4zb.log` **exit0**。正常关闭旧服务并join后才构建；build/types完成且输出冻结后恢复同一`.cache/product`及4177，PID1730870为此次启动记录。健康检查ready:true、loginRequired:false、crossOriginApi:403；用户文档/会话保持原样。最终验证为上述分段记录，不声称check.sh首轮整条exit0。

### 2026-09-10 · Markdown、长回答引用与原 PDF 高亮（ADR-057）

- 只读复核用户实际 Answer：原编译器的16条上限使后续“超过7%”片段没有保存citationId，warning为`limit-exceeded`；不是对论文数字真假的判决。所有未分类片段（含标题/连接文字）又被逐段追加“出处待核验”。保留原回答与manifest不变。
- 采用固定react-markdown/remark-gfm及同步pnpm lock，真实/临时回答支持标题、列表、强调、表格与代码；不执行原始HTML、不请求模型图片、不启用任意模型链接。事实片段只有精确匹配前端插入位置及地址才恢复manifest引用按钮，Read和原PDF身份验证不变。缺失出处统一为一次折叠解释。
- 新编译引用上限对齐现有v1的128条，并加入累计256KiB引用字节预算；溢出仍明确unresolved。没有协议/数据库迁移，没有回写旧Answer或自动重新提问。
- 修复PDF文字节点之间强加空格，按PDF.js真实空格/BR恢复文字层；只在显示匹配额外容忍字母词后逗号前提取空白，数字/词边界/标点/大小写保持严格，重复文本仍不高亮。
- `bash scripts/pnpmw exec vitest run apps/web/test/live-answers.spec.ts apps/web/test/answer-markdown.spec.ts apps/web/test/quote-match.spec.ts packages/core/test/answer-manifest.spec.ts`：**4文件31项通过**。覆盖XSS/外链/图片、伪造内部引用、Markdown结构、旧记录不变、32/128条与大Evidence预算及排版反例。
- `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/answers.pw.ts --output .cache/playwright-citation-markdown`：**2通过**；仓库样例及新增合成上标PDF均通过真实Pi/Read/引用/刷新/高亮，模型为受控测试provider，非真实Azure质量测试。
- `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/selections.pw.ts e2e/live/compare.pw.ts e2e/live/simple-entry.pw.ts --output .cache/playwright-reader-markdown-regression`：**6通过**，含上传、选区、同名版本独立原件、移动端输入布局与失败重试。
- 实际4177页面另行只读浏览器检查：用户论文原第7/9/13/14条引用全部恢复精确高亮，第1条对照通过；“5.实验设计”为真实heading、390px无横向溢出，截图`.cache/citation-markdown-mobile.png`。无私人论文复制进fixtures、无追加问题或额外Azure调用；未声称截图已人工目检。
- 原服务正常关闭并join后才全量构建；build/types完成且输出冻结后恢复同一`.cache/product`与4177。`bash scripts/pnpmw exec node scripts/check-docatlas-running.mjs`：**ready:true / loginRequired:false / crossOriginApi:403**，免登录且原件授权保留。
- `bash scripts/check.sh`首轮日志`/tmp/docatlas-citation-markdown-check.m5jNzv.log`：环境/生成合同/sidecar同步/lint/build/types通过，JS为212文件通过、1文件失败（2850通过、1失败、1既有opt-in跳过）。唯一失败是Probe旧断言把新折叠说明中的重复文本也计作正文；改为分别核对每个A/B正文片段与折叠条目，不弱化两种呈现的同事实/同证据检查。5文件43项定向补验与该测试文件oxlint通过。
- 剩余闸门分段补跑，日志`/tmp/docatlas-citation-remaining-check.GoFTbI.log` **exit0**：`check:plugin`、`check:compat`、`check:protocol`；uv locked的ruff/format/mypy；**1450 Python通过**；`scripts/vendor_flash.py --check`及`verify-packed-flash.mjs`通过。没有把首轮`check.sh`写成exit0。
- `bash scripts/pnpmw run test`全量复跑日志`/tmp/docatlas-citation-js-recheck.3Ipc8p.log` **exit0：213文件、2851通过、1既有opt-in跳过**。测试期间产品二进制保持冻结、服务在线。全部检查以以上分段执行记录为准；OCR/跨栏/其他提取差异及旧16条上限后的历史引用补录仍不属于已完成范围。

### 2026-09-10 · 上传后自然问法失明与输入区布局修复（ADR-056）

- 只读检查用户报告对应记录：两份PDF均ready；“能看到论文吗”和两次“总结全文”的提交及prepared记录实际包含明确sourceRefs，却收到无附件的回答。根因路径为DocumentSession对无选区问题只传原文字，没有当前附件说明；此前真实smoke明确指定工具名/页码，漏验自然提问。未修改用户旧提交或旧回答。
- Core现在从已验证scope添加当前文档数量/精确版本和工具读取说明；无文档问题保持原文，选区文本保留，只有原onConsumed激活来源。明确sequential分页、tree节点与正文block ID的区别；不改Pi工具集合、模型/provider、持久协议或证据授权。新增Core模型上下文4项测试，实际DocumentSession测试增加准备/消耗/换源/无文档断言。
- 按本轮实际查阅的OpenAI工具调用文档与Claude/Notebook来源交互（ADR-056列明URL），将附件、输入、上传/资料和发送合为单一输入面；按钮左下/右下同排，原文件标签在框内上方。主回答改为更轻的阅读版面，原PDF仍按需打开。
- 真实Azure自然问法采用固定仓库合成PDF，只问“总结全文”，不在问题中指定工具：修改前8次实际请求仍未完成，先绕到Bash并出现Read参数错误，后续第9次在本机预算闸门拒绝；修改后首次6次调用完成读取/回答，但旧Q4 smoke的`15.2`字面检查不适合自由中文全文摘要。保留原指定Q4问法检查，自然问法另验实际逐页Read覆盖/EOF、摘要、已证明引用与同hash原件定位。
- 最终`DOCATLAS_SMOKE_NATURAL_QUESTION=1 bash scripts/pnpmw exec node scripts/test-pi-pdf-live.mjs --live` **exit0 / PI_AZURE_LUNA_NATURAL_PDF_OK**：**6次真实Azure调用、6/6页文本读取至EOF、中文全文摘要、checkpoint/attested citation/原件hash及精确定位通过**。人工查看合成摘要，Q4转换为1,520万美元与原15.2 USD M一致。此为合成PDF验证，不冒充用户文档或任意语料质量验收；未把用户PDF用于额外模型测试。
- 最终浏览器 **4+9=13条全部通过**：新输入区在桌面/手机的包含关系、左右顺序、按钮同排位置断言，以及上传/拖入/新建恢复/问答/引用/选区。Answer旅程明确断言实际模型输入含当前附件上下文。输出`.cache/playwright-composer-grounding`及`.cache/playwright-grounded-document-chat`。
- `bash scripts/check.sh` **exit0**，日志`/tmp/docatlas-document-grounding-check.FlQFzG.log`：**212文件、2842 JS通过、1既有opt-in跳过；1450 Python通过**，构建/类型/lint/协议/打包/兼容/Flash源及包核验均通过。最后仅自然问法smoke的评估脚本改为完整读取覆盖与中文摘要检查，已实跑通过并补oxlint；未再改产品二进制。
- 原服务已正常关闭并join，最终构建与上述真实模型/浏览器核验后启动同一4177服务，PID1227311（此次启动快照），仍免登录且保留`.cache/product`。实际服务健康检查`ready:true / loginRequired:false / crossOriginApi:403`；新浏览器检查同框操作区，没有向用户对话追加测试问题。

### 2026-09-10 · 删除本机配对码与登录（ADR-055）

- 用户明确要求去掉登录。CLI固定开启本机直接访问：不生成配对码、不设置登录cookie、不设登录有效期；网页移除表单和注销入口，连接失败只提供重连。本机`/api/auth/*`返回404。通用paired adapter保留为可信嵌入兼容接口，不对浏览器提供模式开关。
- 沿用状态目录决定的actor/workspace，未迁移或删除文档/会话/偏好。保留loopback监听、精确Host/Origin、Fetch Metadata、写CSRF和原文/沙箱/资源授权；禁止公网或共享代理。
- 定向Auth/HTTP/Application/Client **4文件18测试通过**：覆盖无cookie访问、20天不需登录、服务重启直接访问相同记录、旧CSRF失效、跨Origin/null/same-site拒绝、伪造/缺失CSRF拒绝、已移除的认证端点404。只读健康脚本 **5项Node测试通过**。
- `simple-entry/answers/documents/selections/chat`浏览器首轮 **12通过、1失败**；失败点为刷新后的`response.finished()`等待超时。trace证明三次引用均有真实HTTP 200/完整JSON，页面已定位原文。仅将该测试改为等待既有route记录器读完的HTTP body，再验证真实PDF/DOM；不改产品、不删除出处断言、不延长120秒截止。该引用旅程随后 **1/1通过，39.0秒**，并补过E2E noEmit/oxlint。精确日志位于`.cache/playwright-local-access`和`.cache/playwright-local-access-citation`。
- 已部署同一4177服务，PID3239641（此启动快照）；全新浏览器无cookie直接看到且可操作上传按钮和聊天框，输出`LOCAL_WEB_NO_LOGIN_UPLOAD_READY`，没有提交问题或上传测试文件到用户工作区。只读健康检查`ready:true / loginRequired:false / crossOriginApi:403`，不需要用户再输入任何代码。
- `bash scripts/check.sh` **exit0**，日志`/tmp/docatlas-local-access-check.61K5bi.log`：共享构建/全部类型与lint、协议与兼容检查通过，JS **211文件、2838通过、1既有opt-in跳过**，Python **1450通过**，vendor/packed Flash核验通过，末尾`All workspace checks passed.`。服务在所有共享构建结束后恢复；后续仅运行测试及只读/临时打包核验，未在运行服务下重build。

### 2026-09-10 · 首屏减法与直接上传（用户明确要求）

- 默认仅保留聊天、上传、当前提问文件标签；历史/新对话为次要入口，研究/审阅/偏好/运行控制收进“更多操作”，文件版本/Flash/对照与回答整理也按需展开。保留原能力、授权和所有持久数据。
- 新首屏输入/上传显式触发幂等会话创建，失败保留原创建键与问题草稿。文件处理成功后核对同一会话/binding/generation及文档原件hash/大小才自动添加精确revision；旧上传待办不补造自动选择意图。读取或打开其他PDF不改变提问范围，移除标签不删除原件。
- 新增`live-upload-state.spec.ts`，完整验证兼容旧待办、明确新意图、身份不符/格式/体积拒绝。`vitest run apps/web/test`：31文件、313测试通过；Web noEmit、E2E noEmit和前端/E2E oxlint通过。
- 浏览器新增首次空列表/可见文件选择器/自动建会话/原文打开/手机/移除不删原件、首屏无文档问题、创建回执丢失原键重试、拖入/无效文件四条旅程。首次手机axe指出“新对话”图标缺少可读名称，已补aria-label。首轮16条回归通过；最终构建另补手机首屏viewport与旧代际上传意图隔离验证。
- 浏览器使用独立临时应用、现有真实Pi/文档工具与scripted provider，不使用用户文档或付费Azure调用；先在独立`.cache/simple-web.94BL00`构建验证，不在运行服务下改写共享lib/dist。
- `bash scripts/check.sh`：**exit0**，日志`/tmp/docatlas-simple-check.laEdQp.log`。七包构建/类型、lint、合同/打包/Pi兼容/跨语言协议通过；JS **211文件、2835通过、1既有opt-in跳过**，Python **1450通过**；vendor/packed Flash核验通过，最终出现`All workspace checks passed.`。
- 最终独立页面`.cache/simple-web-final.oUGEuD`的9个浏览器文件（simple-entry、answers、documents、selections、chat、compare、enrichments、reviews、probe）**18/18通过，5.8分钟**，输出`.cache/playwright-simple-final`。这是上述选定旅程，不冒称整个浏览器测试目录全检。原PDF引用/高亮/选区、偏好呈现与审阅入口的真实链路仍保留。
- 全量构建后最后的手机空白区CSS调整，使用上述独立Vite构建和最终18条浏览器重验；补跑E2E noEmit与前端/E2E oxlint，全部exit0。只读健康命令的4项Node测试通过。
- 部署前原服务正常关闭并完成join，未删数据库/claim。所有共享JS构建与测试完成后，原样复制最终已测页面到`apps/web/dist`（`diff -qr`一致）；切换前构建保留在`.cache/web-before-simple.vgIbuf/dist`。剩余Python测试/只读vendor与打包检查不改写服务依赖，期间恢复服务，不在运行中重build。
- 09:17 UTC启动新版Pi/Azure Luna服务，PID2344518（仅此启动的快照，不是固定PID），地址仍为`http://127.0.0.1:4177/`，状态目录仍为`.cache/product`。`bash scripts/pnpmw exec node scripts/check-docatlas-running.mjs` **exit0 / ready:true / unauthenticatedApi:401**；没有额外模型调用。配对码仅通过本次终端/对话交付，不写入文档。

### 2026-09-10 · 一小时交付补验：文档与原生计算共存（无运行服务变更）

- 交付末尾新增只读operator命令`bash scripts/pnpmw exec node scripts/check-docatlas-running.mjs [port]`，只允许127.0.0.1，限时/限量比较实际live入口和主脚本bytes，核对CSP/nosniff及未配对私有API=401；不配对、不发送模型请求、不写状态、不输出私有响应。`bash scripts/pnpmw exec node --test scripts/check-docatlas-running.test.mjs` **4/4通过**，相关oxlint通过；01:21:33 UTC对已交付4177实际执行 **exit0 / ready:true / modelCalled:false / stateChanged:false**。首次仅新命令漏接受既有相对`./assets/`路径，依真实built HTML修正，未改服务。此脚本为独立手工operator检查，其Node测试不包含在上一批JS2828计数中。
- 上一goal turn为progress：完成本机部署、Flash与学习集成验收。继续保留4177上的PID787558服务，不修改已建lib/dist、不重启、不访问用户文档；所有新验证使用独立临时应用和仓库合成PDF，无新付费模型调用。
- 新增[e2e/live/mixed-workflow.pw.ts](../e2e/live/mixed-workflow.pw.ts)。通过实际网页上传/选择PDF，由真实Read提取Q4原文/Locator，再通过原生write保存实际输入及Node脚本，原生Bash执行计算、保存CSV/SVG/Markdown/计算JSON，并由原生read读回报告。核验实际文件bytes/输入SHA-256、15.2×4=60.8；网页只保留原始Read的一个引用，计算段仍是待核验内容，不把文件或正确算术冒充已登记派生Evidence。
- 随后在同一真实会话取消资料选择，继续原生21×2计算；核验运行帧不再授权Doc工具，同时原canonical scope保留不变，旧引用仍定位到原PDF页2/高亮且bytes/hash一致。此处检查运行帧权限而非错误要求删除历史scope，符合DocumentSession.prepare/onConsumed的原边界。
- 最终命令`bash scripts/pnpmw exec tsc --project tsconfig.e2e.json --noEmit && bash scripts/pnpmw exec oxlint --deny-warnings e2e/live/mixed-workflow.pw.ts && bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/mixed-workflow.pw.ts --workers=1 --output=.cache/playwright-mixed-workflow-results`：**全部exit0，1/1 browser，34.8s**；8次provider响应为scripted，真正的Pi/文档/文件/计算/HTTP/浏览器均未模拟。
- 首轮仅test locator未包含动态“资料 · 1”计数导致等待；次轮已完成计算及无文档任务，但test错误把历史scope当运行授权。两个测试断言均依源码/实际DOM纠正，未修改product、放宽截止或削减文件/原文/权限断言。
- 01:14:54 UTC再次GET已交付服务主页=200。没有在运行服务读取lib/dist时重新跑会重建的完整check；基线全量证据保留上一批，本次只有新E2E及上述noEmit/lint/最终browser补验。剩余R6正式派生证据/Excel/真实模型业务质量、R7等不因此标完成。

### 2026-09-09—10 · 持续目标第二十六批：并行Flash与跨研究偏好学习

- 上一批为实际progress，不重做已通过的人类研究入口或上游版本审计。本批root合同/HTTP/观察订阅/集成、Core学习、host/Web学习与Flash Core/host四路分工；共享产物仍单producer、消费者运行时不重build。
- [ADR-053](adr/053-bounded-parallel-flash-enrichment.md)与[ADR-054](adr/054-consented-preference-learning.md)先明确原协议/预算/权限/迁移边界，再实施；不是根据测试方便程度缩小R1–R7终点。设计接受不等于功能验收完成。
- 初步共享检查：`bash scripts/pnpmw exec vitest run packages/contracts/test/product-learning.spec.ts packages/contracts/test/enrichment-contracts.spec.ts --maxWorkers=2` **222/222通过**；`env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar pytest python/docatlas-sidecar/tests/test_product_learning.py python/docatlas-sidecar/tests/test_enrichment_contracts.py -q` **221/221通过**。首次仅新fixture的reject候选缺必须的decidedBy/decidedAt，补完整fixture后通过；未放宽真实候选协议。
- Flash源级新旧算法/只读导航 **20/20通过**，实际scripted port峰值v2=2/v1=1、反序结果hash相同、多层full语义对照与abort-ignoring sibling join；不是实际模型/真实业务语料质量或速度百分比。Core早期编译仅遇v2两个unknown收窄问题，改never helper为function declaration后直接Core build exit0。
- 初期实际应用HTTP **4/4通过**，默认off、独立许可、不调Pi、原键跨binding查询、CSRF/身份/输出hash边界通过。RuntimeManager的新订阅在recoverQueued前挂载，实际完成/关闭均成功；三个新反例只因测试将API实际null错误断言为undefined而失败，已改精确null，最终回归待全检。
- Core学习初跑发现v2缺profile_epoch会被当老v1补0，后续已修为拒绝以保留擦除围栏；其余新测试字段/旧schema版本断言已修正。下列最终记录覆盖原来源/反向票/遗忘/回执与host/browser，不以类型检查代替功能验收。

本批最终定向/网页证据（全仓结果另列，不与重叠用例累计）：

- Core最后 **5文件74/74**（新学习28、旧46），直接Core noEmit与owned lint通过。覆盖v2缺epoch拒绝、同事务settings热读/完整input hash、missing counter receipt不被忽略、三INV/相反票/原键旧null、遗忘/导出/擦除和备份迁移rollback。64-member历史夹具拆成受限setup与边界动作，保留全部真实写入/第65条拒绝，不放宽5秒test期限。
- Host新学习 **3/3**、Web state/client **8/8**与noEmit/lint通过；原实际HTTP **4/4**覆盖仍保留。Flash **3文件13/13，69.63s**验证真实PDF/namespace/Domain作业、v1/v2持久回执与adapter独立stream.result join，详见ADR-053。
- 最终built Web回归命令`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/enrichments.pw.ts e2e/live/probe.pw.ts --workers=2 --output=.cache/playwright-batch26-regression`：**3/3通过，1.3m**。验证v2明确recipe/相同原body重开无额外模型、无树不启动增强，以及旧单次Probe确认/使用/原PDF高亮兼容。
- 新学习命令`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/learning.pw.ts --output .cache/playwright-learning-results`：**1/1首次通过，1.2m**。实际Pi/SDK/原PDF、三个真实CID/INV、低频inline邀请不自动开窗、关闭/dismiss不投票、失答复只GET核对旧null、三研究候选/人工确认/后续真实MemoryUse=1、原PDF bytes/hash/高亮不变。14次provider响应是scripted用户问答，学习本身不额外调模型。
- 用户随后要求一小时内交付可用系统，时间窗为2026-09-10 00:22:46—01:22:46 UTC。停止增加范围，冻结源码、全检并行网页验收与部署。按已指定Azure资源做有界实际模型验收：`DOCATLAS_SMOKE_CALL_BUDGET=3 bash scripts/pnpmw exec node scripts/test-pi-pdf-live.mjs --live` **exit0 / PI_AZURE_LUNA_PDF_CITATION_OK**，恰好3次真实Azure调用验证上传→Read→checkpoint→已核验引用→同版原始PDF页2定位；仅仓库合成PDF，无用户私人文档，不作真实语料准确率声明。
- 首次全检止于新E2E matcher的ScopedSourceIdentity类型，改为对象展开后第二轮JS **2827通过/1失败/1既有opt-in跳过**：唯一失败是旧ownership只准同目录Core引用，误拒新的Core内personalization helper。修为解析路径限定Core根并递归核验所有Core模块，保留拒Pi/DSH/React/server与越界path；第三轮只发现测试readdir返回类型需显式utf8，已补并单独Core noEmit/ownership3项/lint通过。均仅测试修正，没有浏览器失败后的production修改。最后完整全检另列，不能将上述失败阶段写成成功。

最终交付核验（2026-09-10 00:58 UTC，用户一小时时限内）：

- `bash scripts/check.sh`最后一轮 `/tmp/docatlas-batch26-check.nDwY8u.log`：环境/生成/110 packaged files/lint、七包有序build/全部types、JS **210文件 / 2828通过 / 1既有opt-in跳过，368.31s**；strict plugin pack、DSH source兼容、Pi24文件patch与跨语言协议全部通过。Python首次 **1449通过/1失败**，唯一是旧M0测试的协议名称枚举未包含新`product-learning`；只补该测试清单，没有production更改。
- 此后只续跑受影响Python与脚本剩余阶段（`/tmp/docatlas-batch26-final-python.fIl34O.log`），不重复已通过JS/Web：`env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar ruff check python/docatlas-sidecar`、同前缀`ruff format --check python/docatlas-sidecar`、`mypy --config-file python/docatlas-sidecar/pyproject.toml python/docatlas-sidecar/src`、`pytest python/docatlas-sidecar/tests`、`python scripts/vendor_flash.py --check`，随后`bash scripts/pnpmw exec node scripts/verify-packed-flash.mjs`。整组 **exit0**，ruff63文件/mypy24源、Python **1450通过，192.61s**、Flash83文件/25函数与packed82文件/provenance通过。检查项以全量JS+Python尾段补验共同覆盖，不声称同一次完整脚本跑到成功末行。
- 最终构建前后Flash v2/Core profile/host学习/Web主bundle四份SHA-256相同，后续只有测试/文档修改；本批4条已通过的browser流程不重复跑。最终文档核验13份/161个本地文件链接全部存在，不声称核验外链或全部锚点。
- 实际启动命令：`bash scripts/pnpmw exec node apps/server/lib/cli.js`，使用真实Azure Luna、现有`.cache/product`、固定loopback4177。启动前只读确认默认库1个空会话、0提交、0writer、0runtime claim，未替换用户数据。启动后00:57:50 UTC：**PID 787558监听127.0.0.1:4177；GET / =200；未配对GET /api/conversations =401**。一次性配对码仅终端/用户交付消息，不写本记录；服务保持运行，其他测试消费者均已退出。
- 用户入口：[START-HERE](../START-HERE.md)。交付为可用的单用户本机版本，保留全部已实现基础流程与本批增强；R1–R7余下完整native parity/复杂语料/迁移恢复/公网发布等仍如实开放。没有stage/commit、上游写入或隐瞒为全规划/公网生产验收完成。

### 2026-09-09 · 持续目标第二十五批：独立人类研究与PDF直接批注

- 按用户要求复用三Agent分工，Core/host负例、真实浏览器新旅程、旧UI兼容旅程与root合同/HTTP/有序构建/文档并行；共享`lib/dist`仅由root生成，消费者开始后不再重建。
- [ADR-052](adr/052-human-research-authoring.md)落地独立`human-research.v1`：无PDF可建Note/Question/Decision/Policy，PDF选区提供「加入问题 / 保存到研究」两种独立意图。保存既不发问题、不改Ask草稿/来源/票据，也不执行Pi/伪造Agent作者、SelectionContext或Evidence。精确核验的quote/Locator供回原PDF，不替正文做事实背书。
- 同一SourceScopeStore canonical journal上增加v6人类记录/最小命令回执投影；v5先备份再事务迁移，临时库测试保留旧bytes/hash并验证rollback。全文/CAS/typed生命周期、Recall/Notebook/Continuity/精确page overlay继承原source/conversation权限。新human Governance保留原source四元组/hash，缺marker/回执或删除投影不降级成legacy。旧mutation入口不能绕过human commit context。
- 认证HTTP独立验证完整route/target/budget及command hash/action/版本；操作GET只读且可核对原代际原键。浏览器保持同tab/owner/body/key，不自动重发/换key/回填已删正文；原型与真实live不混用。规则只记录人类约定，不自动执行或成为个人记忆；未提交编辑稿跨分支保留仍是待验缺口。
- 初始定向：共享Node/static browser **99/99**，Python human与M0 catalog **131/131**；Core最终human **26/26**、含旧store/Continuity组合 **54/54**；Web7文件 **53/53**。这些与全量有重叠，不能累加为独立测试数。
- 最终构建后的host补验：`bash scripts/pnpmw exec vitest run apps/server/test/human-research.spec.ts --maxWorkers=1` **11/11**，对应文件oxlint通过。包含同revision Governance representation/hash漂移对get/query/receipt/revise的拒绝，及legacy mutation不能写新human Note/Question但可信新入口可正常编辑；仅改测试，无production/build更改。
- 旧浏览器兼容：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/notebook.pw.ts e2e/live/selections.pw.ts e2e/live/compare.pw.ts --workers=2 --output .cache/playwright-human-regression-results` **4/4通过，1.2m**。保留原票据/提交消费/失回执原键核对、跨会话全文CAS、原PDF及A/B窄屏等断言；不重建共享产物。
- `bash scripts/check.sh`第三次整条 **exit0**，日志`/tmp/docatlas-batch25-check.BQuxcV.log`：固定环境/生成bundle/110 packaged sidecar files/deny-warnings lint/7包有序build/全部types；JS **202文件 / 2680 passed / 1既有opt-in skipped**（320.80s）；strict plugin、DSH/Pi24文件兼容、跨语言协议；Python ruff62文件/mypy24源文件/**1374 passed**（182.23s）；Flash vendor83文件/25函数与packed82文件/provenance全部通过。两个早期失败分别是可选`usedChars`缺undefined保护和test闭包联合类型缩窄，均在最终全检前修正。HTTP初跑的Core预算、delete测试undefined字段和logout认证先后也已修正并包含于最终全检。
- 两条新增human browser使用真实`startDocAtlasApplication`/RuntimeManager/SDK/原PDF，仅provider响应scripted。首轮`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/human-research.pw.ts --output .cache/playwright-human-research-results`为 **1通过/1失败，1.1m**：无PDF四type/全文CAS/typed revise/原键GET/删除不恢复正文通过；另一条已验证独立保存/Ask字节票据scope不变/原PDF，失败是测试错用“引用原文”文案，真实正确状态为“已定位核验选区”。仅改spec预期，不改变产品/Evidence边界。
- 随后`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/human-research.pw.ts --grep 'saves a real PDF selection' --output .cache/playwright-human-research-results` **1/1通过，49.9s**。覆盖未知Ask时独立批注、原回执恢复、精确原PDF字节/hash/页/高亮/只读overlay、实际新CID跨会话查看以及Pi `docatlas_recall`找到新human Note；无新Read故无可点击Answer Evidence。两条分别实际通过，不记成单次2/2或全Live套件验收。E2E直接noEmit和新增spec oxlint均exit0；所有临时应用按实际join关闭。
- 文档复核发现Question编辑上限文案/UI与Core4000不一致，已统一typed-limit helper/Form/命令构造：Question新建/编辑4000，Note新建4000/编辑8000，治理8000；新增Unicode scalar边界（含astral）与8种type/edit组合SSR断言。README Pi依赖未来时态也已纠正。最后13份文档 **185个本地文件目标全部存在**，未联网外链或声称核验所有锚点。
- 该三文件UI小修晚于上面全检，单独补验，不重复无变化的后端/Python全量，也不伪称此前全检覆盖随后改动。Agent state/client **23/23**与Web直接noEmit/3文件lint通过；消费者全部退出后root执行`bash scripts/pnpmw --filter @docatlas/web-demo build` **exit0**（`/tmp/docatlas-batch25-web-final.Gvxav3.log`）。随后`bash scripts/pnpmw exec vitest run apps/web/test/human-research-state.spec.ts apps/web/test/live-human-research-client.spec.ts apps/web/test/live-layout.spec.ts --maxWorkers=2` **3文件27/27通过，6.67s**，`bash scripts/pnpmw run lint` **exit0**（`/tmp/docatlas-batch25-web-focused.y0gRLI.log`）。
- 最新Web产物上只补跑受影响的第一条人类研究旅程：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/human-research.pw.ts --grep 'authors all four free human record types' --output .cache/playwright-human-final-results` **1/1通过，18.9s**。四类自由记录/全文CAS/resolve/revise/原键GET/删后不回填均通过、模型调用0；其余5条此前已通过的unique浏览器流程不重复执行。之后无源码或共享产物修改，所有消费者停止。
- [PageIndex/SDK复核](../research/38-pageindex-sdk-followup.md)为只读线上/源码审计，source gate通过；pins不变，无新Flash算法可升级。纠正Python稳定0.2.15/源码占位及JS发布0.8.0/main差异、逐操作scope边界；benchmark的running-text/拒绝PDF排除/未检测license限制保留。后续有界并行增强未被调研自动批准或实现。
- 未付费调用新模型、未公开部署/启动4177常驻、未stage/commit、未改只读上游或迁移现有用户库。完整目标保持active，R1–R7其余验收不被本批替代。

### 2026-09-09 · 持续目标第二十四批：原生分支交接、原证据与Flash标题

- SDK保留实际`navigateTree`/`fork`与扩展hooks；selected leaf与文件tail分开，无伪问题checkpoint。导航保持live model/thinking，fork继承真实路径/label/compaction映射和child原生queue；没有新增Pi补丁。SDK/controller **45/45**、selected-history相关 **17/17** 已通过。
- `native-lineage.v1`及history/Answer的可选selectedHead/origin合同，Node/static-browser **146/146**、Python **146/146**；旧v1仍合法，原manifest不重标。
- Catalog v2与reserved→native-proved→joined→installed→binding-committed→complete交接保留真实namespace/effect join。新host真实场景 **6/6**；相关host回归 **122/122**；store/CAS/migration/journal **26/26**。冷原键恢复仅完成已经证明的metadata交接，不重复SDK/model，也不接管未知claim。
- Web按需分支面板与四个lineage client方法已接；新/旧outbox相关 **36/36**。主线程另补selected-head history、分页/迟到结果、精确历史origin与原PDF引用，首组client回归 **39/39**。旧代际receipt不冒充当前分支问题；跨会话Probe明确回原会话，不能重标Answer来复制投票。
- source访问撤销不等于擦除已有Pi聊天；当前/原会话权限决定native历史可读，canonical Answer/证据/原件另核对源权限。此边界已在ADR-050明确，不称历史文字仍获证据授权。
- Flash按ADR-051通过reviewed generator产出83文件/25原确定性函数；pin仍ae16956。相同PDF的no-cover repeated **0/4→4/4**、distinct **3/4→4/4**，cover对照保持4/4。**11/11**配对/反例、原**4/4**质量gate与**48**专项测试通过；后续纯generator/source admission **41/41**。未改只读上游、旧index generation或付费模型。
- 额外真实PDF/history/publication **10/10**：同CID off-branch旧Answer可读、跨CID仅选中真实继承、原human/purge不漏注入、原会话/source撤权与hash漂移、fresh Read和cursor边界。metadata/label实际SDK补验 **14/14**（含新增4）：navigate/fork-at可用，before仅user。native-tree与manager/Stop **11/11**（44.62s）：100节点分页/公开body白名单/实际depth/labels、异步原文擦除复验、冷Stop不启动或猜claim。
- `bash scripts/check.sh`整条exit0，日志`/tmp/docatlas-batch24-check.8R2BlM.log`：固定环境、生成bundle、110 packaged sidecar files、deny-warnings lint、7包有序build/全部types；JS **195文件 / 2514 passed / 1既有opt-in skipped**（291.22s）；strict plugin、DSH/Pi24文件兼容与跨语言协议；Python ruff61文件/mypy24源文件/**1275 passed**（180.66s）；Flash vendor83/25函数、packed82 source/data/license+provenance通过。6个打包副本通过既有sync脚本同步。专项与全量存在重叠，不累加成独立用例数。
- 曾误触一次package `pretypecheck`依赖构建，立即停止；相关那次9/9不作为最终证据。确认消费者退出后由root按contracts→core→runtime-pi恢复一致依赖，10项真实history tests重新通过；后续统一生产仍由root收口。
- 浏览器使用真实`startDocAtlasApplication`/RuntimeManager/SDK/PDF、仅provider回答scripted：两个新分支旅程已通过。覆盖丢navigation响应→跨代原键GET核对零重放、同SID generation+1、原PDF字节/hash/页2高亮、刷新、fork-at新CID/SID/原Answer归属、显式重选sources并fresh Read；另覆盖首user父位置的空human历史、fork-before、空草稿和新提问。不以固定binding harness伪造交接。首次cold启动只修正测试等待精确snapshot完成的因果点，没有预热或放宽业务期限。
- 最后静态复核发现旧标签页Stop仅发`{}`可能取消换代后的新任务，已补新Web强制`If-Match:"bindingId"`、调用取消前CAS、manager等待owned后再验binding；旧空body API兼容且明确没有CAS语义。此修补晚于上述全量JS，不伪称整脚本在最后代码重跑。最终7包有序build/所有types/lint再次exit0（`/tmp/docatlas-batch24-final-build.pWMrzv.log`），最新HTTP/manager/树/实际历史/原件/通用HTTP及Web **10文件74/74** 定向通过（52.97s，`/tmp/docatlas-batch24-final-focused.J8cUJ2.log`）。
- 最新browser首轮 **3通过/1失败**：两条lineage再次通过，新增真实Web Stop亦通过——冻结header/body、实际provider abort+finally join、native/worker/coordinator idle、durable cancelled、旧checkpoint不变和后续新问题completed。唯一失败在旧compact旅程末尾mobile drawer reveal动画未结束时取bounds，原compact/原PDF/fresh Read主链均通过。仅在该spec等待drawer自身有限动画finished（取消可结束、无sleep/禁动画），保留391px阈值，定向compact **1/1通过，37.9s**；其余3条不重复跑。全部新增E2E显式noEmit与lint通过。不把分段结果写成单次4/4或全Live套件验收。
- 实际最终browser命令：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/native-lineage.pw.ts e2e/live/native-compaction.pw.ts --output .cache/playwright-lineage-results`（默认1 worker）；随后只执行`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/native-compaction.pw.ts --output .cache/playwright-compaction-final-results`。独立临时应用和faux模型在结束时正常关闭，不留常驻服务。
- 详细Flash证据见[质量记录](../evals/flash-quality/README.md#batch24-reviewed-numbered-heading-adjustment)。没有付费模型调用、公开部署、4177常驻服务、stage/commit、只读上游修改或用户数据迁移。完整目标仍active；下一队列继续R4研究入口/学习、自动跨边界Read归属、真实语料与恢复/运维。

最终Stop修补后的精确构建与74项补验命令（不重复未改变的Python全量）：

```bash
bash scripts/pnpmw run check:build
bash scripts/pnpmw run check:types
bash scripts/pnpmw run lint
bash scripts/pnpmw exec vitest run \
  apps/server/test/native-lineage-http.spec.ts apps/server/test/native-lineage-manager.spec.ts \
  apps/server/test/native-tree.spec.ts apps/server/test/lineage-history-answers.spec.ts \
  apps/server/test/product-http.spec.ts apps/web/test/live-client.spec.ts \
  apps/web/test/live-native-history-client.spec.ts apps/web/test/live-lineage-client.spec.ts \
  apps/web/test/live-layout.spec.ts apps/web/test/live-answers.spec.ts --maxWorkers=2
```

最后11份更新文档的137个本地文件链接存在性检查通过；链接检查不宣称外部网址或所有Markdown锚点已联网核验。

### 2026-09-09 · 持续目标第二十三批：手动压缩、中文召回与真实PDF质量门槛

- 按用户加速要求复用现有三Agent与主线程并行：SDK/worker→浏览器、host/存储/生命周期、Flash质量/中文检索、共享合同/Web/集成。生成与构建仍只由主线程执行；不在消费者运行时改写lib/dist，不重复无关重型旅程。
- [ADR-049](adr/049-manual-native-compaction.md)把真实公开SDK compact接到既有native操作/认证Web：可选4096字符保留说明、实际SDK资格提示、整请求/hash/approval/head/原键，成功须真实compaction entry/firstKept/token记录/summaryHash与固定前后prefix。配置旧v1语义不变，summary不暴露为新Answer、Evidence或个人记忆；不改Pi24文件补丁、generation或旧出版。
- 正常取消/SDK拒绝只有真实promise与effects join、native suffix精确intent+not-applied两条时才有独立failureProof。SDK已写compaction而after-hook随后拒绝仍以实际成功记录为准，不能谎称回滚；额外native改写、缺证明保留unknown。原键冷恢复只用已clean目录/metadata writer，不跑factory/model。failed proof不可覆盖，unknown→failed需它；applying仅代表host准入，不猜已经dispatch，明确尚未发起IPC时允许既有安全失败。
- 复核关闭两处join窗口：compact terminal后先封新的broker effects再等待已发起native/model/document handlers；未知/丢IPC分支也在finally drain，closed pipe再等真实SandboxProcess namespace，不凭idle/PID/计时器。300秒whole call+drain预算只触发停止，不跳过实际join；join后再验权限。结束hook的迟到派生native调用在下次显式动作前拒绝。旧Read frame在compact前失效，下一问重新准入/消费。
- Web仍按需「运行设置」抽屉，不改变居中聊天。说明模型费用、摘要可能省略细节、完整历史/笔记/原PDF引用保留；已证未应用与未知分开。原键待办只匹配完整回执，正常取消不永久堵住新问题，刷新不重跑压缩/提问。压缩不是隐私删除，也不撤销扩展外部effects。
- 初始定向：共享Node/static browser两文件89/89、Python87/87；Web四文件44/44；实际SDK新旧组合12/12；CJK/既有document-service/生成PDF四类26/26（37.06s）。各组有重叠，不与全量累加。runtime/Web直接types、lint及Python格式检查通过。
- 首次check在打包副本未同步的前置检查停止，未构建；用既有sync脚本同步两文件。第二次通过七包有序build与全部package types，停于新E2E的toMatchObject(ScopedSourceIdentity)类型，改为对象展开；没有改变行为断言或增加期限。第三次`bash scripts/check.sh`整条exit0，日志`/tmp/docatlas-batch23-check.lnx8st.log`：环境/生成/109 packaged files/lint、有序build/全部types、JS **181 files / 2254 passed / 1既有opt-in skipped**（256.37s）、strict pack/DSH/Pi24文件兼容/跨语言协议；Python ruff57文件/mypy24源文件/**1082 passed**（140.61s）；Flash vendor82文件/25函数、packed81文件/provenance全部通过。
- 最后host finally/closed-namespace/权限复核修补晚于上述全量构建，未伪称全脚本在最后代码上再跑。所有消费者退出后统一有序重建、全部types与deny-warnings lint通过（`/tmp/docatlas-batch23-final-build.KndsJN.log`）。最新host/SDK **7文件59/59**定向补验（86.52s，`/tmp/docatlas-native-compact-focused.1eOROq.log`），涵盖真实停止/原生进程join、COMMIT后dispatch前取消、丢IPC、closed namespace、冷无factory恢复与后续问题；所有原期限保持。
- 新旧native browser首轮1通过/1失败（1.3m）：55轮真实历史回归完整通过；新compact已经走过真实压缩/原始prefix/辅助调用/丢POST响应/刷新/旧PDF，失败是测试假设“无Read也必有unresolved manifest”。实际产品是completed问题+无可用引用记录，仍正确显示出处待核验。测试改为检查真实completed回执、新native区间仅user+assistant/零Read/toolCall、真实Answer无citation；没有放宽原文或新Read必须有效的断言。
- 最终最新产物上的`native-compaction.pw.ts` **1/1通过，40.6s**（`/tmp/docatlas-native-compact-final.vepILO.log`）：真实PDF/Read→六次16k正常回答→保留说明/真实compact与独立entry/hash证明→模型辅助调用增长而presentation policy不调用→原始history不增假消息→丢响应刷新零重放→旧同版PDF/hash/高亮→无新Read无citation→重新Read恢复同原文/Locator有效引用→390px设置/PDF交互。provider答案/摘要明确scripted，不是模型摘要质量证明。两条不同native旅程在首轮/补验分别通过，不宣称整个Live套件本批全跑。
- [Flash生成PDF质量gate](../evals/flash-quality/README.md)实际走受限ingest/raw/merge/Search/locate/原PDF bbox，未mock树或geometry。同hash中文8页、80页的子串Search从0/8、0/80变为8/8、80/80；中文locate逐页与首末页原文bbox通过。修复仅本地query-time有界Han字面补充：原FTS/BM25优先、source/ordinal稳定、body真实匹配，跨sources共享8192 blocks/200万字符/1600万字符×词预算；ASCII不增加scan，超限明确缩范围。未改FTS schema/index/canonical tree/vendor，也不是中文语义检索。
- 完整四类质量报告`/tmp/docatlas-batch23-flash-quality.B7oQ7P`仍**exit2**：无独立封面且章节模板高度重复的中文/英文案例分别raw/merge空树，共4个section-coverage缺口。只读trace定位到上游title-echo把首章当文档title并过滤相似章节；英文书签枚举启发式另拒合法模板。单变量标题/书签实验只证明特定局限，merge继承空raw不是独立合并bug。两带书签案例达标不替代真实语料、OCR/复杂布局、legacy/full/真实模型质量与默认启用门槛。
- PageIndex/JS SDK线上heads仍ae169566/9925e8a，没有新上游升级；`bash scripts/verify_sources.sh`10个pinned输入全部clean/reproducible。最终12份相关文档127个本地链接（含锚点）核验通过。未调用新付费模型、未stage/commit、未迁移用户数据或修改只读上游。没有启动4177常驻服务。主计划v1.5、ADR/使用/架构/迁移/兼容与质量记录同步；完整目标保持active，下一批branch/fork、更多研究/学习、质量与恢复/发布不被本批替代。

### 2026-09-09 · 持续目标第二十二批：原生设置与真实历史分页

- 本轮为progress；SDK/worker、历史/存储与host测试、Web/真实旅程、父协议/服务/客户端四路并行，复核再次并行。没有重复上批调研或并发改写共享产物。
- ADR-048新增native-control/product-history v1与Node/static browser/Python绑定。host目录和SDK真实thinking（含max）不裁减；首问前O_EXCL持久化使用公开SDK header/全部entries，fsync/reopen复核，无新Pi patch、假消息或假问答checkpoint。
- intent→原生setter→committed metadata；host独立读before/after prefix，真实model/thinking/双queue重开恢复。独立private NativeOperationStore不迁移ControlStore v1，不存第二份聊天；完整body/hash/key、writer/CAS/跨generation未决屏障、原成功不可覆盖。GET只读，unknown仅明确原键找回commit证明，不重复setter。
- 历史只沿同一verified checkpoint实际parent链，50条/131072字符/单条65536；空tool/thinking-only节点不作锚点，unknown/purged用户保持空占位而不泄prepared注入。snapshot100/page50重叠自动跳过；旧完整Answer/原PDF继续可查。Web同时显示上限2000条/8MiB，原生文件不删除。
- 已通过定向：新wire Node/static50、Python48；SDK源9+真实worker3；host native6、history纯6+host13、native store19+public user6；Web native/factory24+新client11、既有相关35。各组有重叠，不与最终全量重复相加。
- 并行复核真实复现并修复：stop未join就重开、applying FULL COMMIT后writer过期仍dispatch、tool-only空assistant阻断merge、旧Answer401/403清空新actor。以真实factory pi.exec计数文件复现并封住冷unknown的startup副作用；无SDK执行的metadata recovery/只读观察均保持counter=1/modelCalls=0/nativebytes不变，恢复后只读hub仍不启动factory，后续显式fresh inspect才允许counter=2。新增host review3与client audit2全部通过。
- PageIndex main仍ae169566b3148792776531d987f543edcad92321，JS SDK仍9925e8a347a9985424f4bb4e95718a75814b9b67；没有新主分支更新。既有Flash raw/merge/summary/expand/full保留，无新付费调用或上游/用户数据变更。
- `bash scripts/check.sh`整条exit0：固定环境/生成/109 packaged files/lint、七包有序build/全部types，JS177 files / 2189 passed / 1既有opt-in skipped（241.37s）；strict plugin pack、DSH兼容、Pi24文件patch、跨语言协议；Python ruff54文件/mypy24源文件/1029 passed（120.24s）；Flash vendor82文件/25函数及packed81文件/provenance全部通过。本批实际跑到All workspace checks passed。
- built Live首轮24项：23 passed/1 failed（11.9m）；失败是新Native UI先取busy/null inspection、随后取成功operation并清outbox，却未刷新inspection而一直隐藏表单，不是后端设置未保存或55轮模型运行超时。已补成功回执后的单次因果只读回读/过期身份丢弃/失败unverify，并新增5个deferred测试；不放宽期限/删断言，单动作期限收紧为15s。其余23项原始PDF/Compare/Notebook/偏好/Probe/Review/Continuity等通过。
- Live在共享build、全部JS/native/compat结束后与剩余Python验证并行，测试期间无lib/dist改写。`playwright --config playwright.config.ts --workers=1`旧Reader6/6通过（22.6s），在整套Live退出后单跑；既有border/borderColor warning保留。
- 首次UI补验已通过全部settings与55轮native读取，又发现旧Answer异步加载造成37.6875px的锚点偏移。已用受身份/输入意图约束的ResizeObserver保持原消息位置，用户滚动/点击/键盘意图立即释放；仍按2px而非放宽阈值验收。最终`native-history.pw.ts`完整旅程1/1通过（38.4s）：真实双模型/SDK档位/双queue、首问前无model/假assistant、真实commit后丢响应/reload只读恢复、busy真目录、PDF真Read、55轮/110消息/三页重叠、原用户文案/草稿资料不变、旧引用原PDF/可信高亮、刷新零重放。
- 上述两处后续修改仅在Web；每次均等browser退出后单producer更新Web产物。最终Web全测23文件/235通过（10.43s），Web构建/typecheck、E2E全types和workspace deny-warnings lint通过；不把较早的完整check.sh说成是在这两处UI修复后重跑。
- 后续chat补验又暴露既有等待夹具：首个新会话snapshot已有200 headers但请求未完成，后续同绑定快照已正常到达并使页面ready，测试却仍等首个response.finished。trace分别记录bodySize=-1和753bytes完整JSON。夹具改等精确原binding的requestfinished，不增时限/不重发问题；最终chat5/5通过（38.5s）。结果是原23条通过，加新旅程与受影响chat分别复验，不伪称24条在同一次新全跑中全绿。
- 主计划v1.4、ADR/架构/使用指南/迁移/兼容和审计跟进同步；本轮未stage/commit、迁移用户数据、修改上游或启动4177常驻服务。全量与定向进程都已退出；完整目标仍active，下一实现队列见主计划§20。
- 完整目标仍active：手动compact/fork/selected-head/跨边界引用、更多学习轴/自动学习与真实质量、完整研究入口、Flash/geometry真实语料、整体恢复/迁移/公开发布未完成。

### 2026-09-09 · 持续目标第二十一批：受控呈现学习与原子导入回执

- 本goal turn为progress：Core/Profile事务与host权限、Probe Web/原PDF/真实旅程、Library恢复/共享协议测试、父线程协议/renderer/客户端/集成四路独立推进；不是缩小完整目标或仅更新计划。
- ADR-047把用户主动answer-order Probe接入产品：一份完整canonical Answer/Read Evidence，实际内容与两个固定recipe重新hash，只有回答/证据两节顺序不同。所有弱证据/unknown/qualification/conflict保留，不调用第二次模型。真实M4 Claim集合可空（共享旧schema增量min0，Evidence仍1+），不伪造Claim IDs。
- Profile仍只存reference/hash/typed preference。新guarded Probe与choice/observation/pending candidate/原命令receipt在既有DB/journal事务内写入；epoch、原贡献policy CAS、同步authorities、一票/同键完整body冲突、失败回滚与旧raw隔离已测。独立review-candidate用完整product hash及事务内原Answer授权；opt-out不使过去合法receipt或明确确认失效，擦除epoch仍拒旧请求。
- JSON/Markdown导出共用隐私过滤bundle，补可导出的eligible未晋升候选/observations/choices，剔除已忘记来源和session-only数据；不增加source text/Locator/真实Evidence副本。旧Profile schema与DB表结构保持，内部receipt随原profile清除。
- Web从真实保存回答按需打开，默认未选择/仅本次，明确工作区选择仍需独立确认；原PDF引用保留。outbox固定actor/ws/binding/generation/profileEpoch/原Answer/Probe/完整body/key，仅只读同hash回执或明确discard清理；不把全文写入待办。native history text hash也由client独立核对。
- Library document/alias/record receipt/job成功现同一事务；后续异常/取消/registry失败不能降级已提交成功。旧孤立记录仅显式原键重试，重构完整原record hash并核对原journal图像/alias/accepted-job hash后修复；queued/running重开转failed也不得盲目重ingest。status继续纯读，后来的current revision不替换原回执。故障注入覆盖事务前后和真实重开；未声称完整host死亡监督/硬件掉电验收。
- 已知定向通过：Core新/既有Personalization5文件42项；host真实Control/Library/ReadReceipts/JSONL checkpoint/private publication10项；Library Core+scope41、compiled ProductLibrary/legacy9；Probe Node/static wire46+纯Core19、Python46；Web view/state22+client11。各组有重叠，不与全量重复相加。client首轮fixture缺少checkpoint而被正确拒绝，补真实形状checkpoint后11/11。
- 唯一拓扑build通过；`playwright --config playwright.live.config.ts probe.pw.ts revisions.pw.ts` 2/2（1.4m）。真实Pi/PDF/Read/存储：partial Answer保留unknown、A/B零额外model calls、原PDF、choice提交后丢响应→reload只读恢复、贡献off后独立confirm、下一新问实际MemoryUse；旧Answer/PDF/来源不变。模型措辞显式scripted，不冒充真实模型质量。
- `bash scripts/check.sh`整条exit0：环境/生成/109 packaged files/lint、七包单次有序build/全部types、JS163 files/2038 passed/1既有opt-in skipped（216.60s），插件strict pack/DSH兼容/Pi24文件patch/跨语言协议，Python ruff53文件/mypy24源文件/pytest981 passed（117.55s），Flash vendor82文件/25函数/packed81文件及provenance全部通过。与上批分段补验不同，本批完整脚本确实跑到`All workspace checks passed`。
- built Live全量23/23通过（6.7m），无重试或放宽时限；包含新Probe桌面/390px手机WCAG2A/AA扫描与无横向溢出检查，以及全部旧chat/Library/Flash/selection/Notebook/preferences/Review/Continuity旅程。`playwright --config playwright.config.ts --workers=1`旧Reader6/6（22.8s），在其余重型测试结束后单跑；既有border/borderColor warning未顺带修改。原型产物hash保持上一批不变，本批未重复其14个无修改用例。
- PageIndex/JS SDK线上仍ae169566/9925e8a，10 pinned research checkouts clean；已接raw/merge/summary/expand/full保留，不虚构新上游更新。没有调用新付费模型或启动4177常驻服务。
- 同时完成[下一批原生控制只读审计](../research/36-native-controls-and-lineage-gaps.md)：SDK功能已具备，缺产品operation/head/权限/历史与跨压缩/steer归属；这不是新功能验收，具体施工顺序进入主计划而不裁减完整目标。
- 12份更新文档158个本地文件链接核验通过；本批测试/构建进程均已退出，没有stage/commit、用户数据迁移或上游写入。
- 主计划v1.3/ADR/使用与迁移文档同步。完整R1–R7 active：automatic/multi-axis/纵向个性化、更多研究入口、完整native controls/parity、真实语料/Flash/geometry评估、整体备份/恢复/迁移及公开发布仍待。

### 2026-09-09 · 持续目标第二十批：版本历史与可追溯的继续核验

- 用户要求加速后四路并行：Core/host Continuity、版本及连续性Web、Library/真实PDF集成与browser、客户端/统一构建及文档；生成与build仍只有一个producer，避免覆盖测试产物。
- 新product-library允许显式同document新revision、事务CAS、不可变content-hash bytes与同当前bytes复用；历史bytes重导入明确拒绝。历史原件按精确revision/representation/source permission解析，读取后再验bytes/hash，不改写旧Answer/Claim/Artifact。
- 新product-continuity从已保存Note/Claim/Artifact进入；Core覆盖canonical Answer/selection及完整derived input closure，缺失依赖不再漏报unaffected。Note使用原ResearchScopeSnapshots权限adapter，正文不作Evidence；M4保留原命令/派生/出版授权。
- 人类选择真实已完成scope与双侧新Read Evidence，原PDF逐项resolve后才保存comparative状态；固定record version和完整请求hash，原receipt可对账，不能换key/scope/旧版本重新判断。仅dependency impact不是自动语义diff。
- Web保留默认chat-first；版本/核验按需展开，A/B可打开旧原件，来源选择含完整doc+revision。上传/判断未知结果保留owner/body/key outbox，刷新只查、不重发、不自动激活Pi来源；原研究/本地出版不改写。
- 聚焦验证：Library Core新14与旧scope14组合28通过；历史两PDF1与Answer/Library33通过；ProductLibrary host真实存储/HTTP5通过；Continuity host12/Core canonical14/journal3/service2/Node+static-browser25、Python24通过；版本/Continuity与相邻Web58、客户端新增17通过。集合部分重叠，不与后述全量相加。
- 新增`revisions.pw.ts`与`continuity.pw.ts`实际旅程2/2通过（1.5m）：同document更新、原响应丢失后只读状态、旧/新原件字节+ETag+高亮、两版Pi实际Read、旧Claim入口/依赖检查/双侧PDF、固定version人工判断/原键replayed及reload不跑模型；旧Claim/来源不改写。模型措辞显式scripted，不声称真实模型/人工视觉质量已验收。
- 首次`bash scripts/check.sh`通过环境、生成、sidecar、lint和完整单次拓扑build/各包types，停在新E2E的`toMatchObject(ScopedSourceIdentity)`静态类型；改为对象展开后direct E2E tsc通过。同步新`scopeOptionsTruncated`时客户端曾遇到旧compiled validator，统一生成后17/17通过；未改协议断言。
- 再次`bash scripts/check.sh`通过环境/生成/109 packaged files/lint、七包单次拓扑build与全部types；JS全量156 files中155通过/1失败，1904 passed/1 failed/1既有opt-in skipped（232.18s）。唯一失败为1024次独立FULL fsync准备压力夹具触发15s test时限，无行为断言失败。保持1025 distinct canonical origins/原边界/原时限，改为单事务seed同样真实行并加writer-replay等价/完整resolver验证；该文件14/14补验通过（10.56s），Core/E2E types与lint再验通过。没有再次重跑未改的全量JS，不称本次脚本整条exit0。
- 按原脚本续验`check:plugin`/`check:compat`/`check:protocol`通过，含Pi24文件patch；Python ruff/format52文件、mypy24源文件通过。pytest全量934 passed/1 failed（114.91s），唯一失败为M0测试固定catalog漏列新`product-continuity`；补入后完整M0文件32/32（2.75s）及ruff再次通过。新共享合同本身全部通过，未修改生产validator。vendor82文件/25函数与真实pack81文件+provenance通过。
- built live全量22项首跑20 passed/2 failed（6.7m），与已完成build后的Vitest并行。trace证明Answers citation POST在4.96s后200/resolved，原5s DOM等待刚超时，Reader随后出现；socket hangup发生在fixture finally关闭后。Chat创建原键回执3.3ms返回，懒启动snapshot仍pending时5s DOM等待结束，未证明运行失败。两处测试改为先等待精确成功HTTP回执/真实snapshot，再执行原DOM期限；不改产品/总时限、不加retry，PDF/hash/no-replay断言保留。受影响两文件6/6补验通过（1.0m）；22个不同live用例均在本批全量或补验中通过，不将6项重复相加。
- `bash scripts/pnpmw exec playwright test --config playwright.demo.config.ts`：原型14/14通过（1.1m），在live消费者结束后运行其独立build。`bash scripts/pnpmw exec playwright test --config playwright.config.ts --workers=1`：旧DSH Reader6/6（21.3s），在重型测试/构建退出后单独运行。三套浏览器共42个不同用例在本批全量或补验中通过；既有大chunk与旧border/borderColor warning保留，不顺带重写旧UI。
- PageIndex在线main复核仍`ae169566b3148792776531d987f543edcad92321`，JS SDK仍`9925e8a347a9985424f4bb4e95718a75814b9b67`，不虚构新版本；已接raw/merge与显式summary/expand/full继续保留。
- `bash scripts/verify_sources.sh`：10个source全部clean/pinned；9份更新文档的103个本地文件链接最终核验通过。所有本批测试/构建进程已退出；未调用付费模型、未启动4177常驻服务。
- R1–R7完整目标继续active；Library domain→job crash窗口、完整impact发现/历史/恢复、自动学习/Probe、真实模型质量/native parity与公开发布未因此完成。无用户数据迁移、stage/commit或上游写入。

### 2026-09-09 · 持续目标第十九批：人类结论、审阅与本地成果

- ADR-045把ADR-044的Core人类应用接入产品HTTP与按需「结论与审阅」工作面；六命令为claim-save/artifact-create/review-attest/review-run/review-decide/artifact-publish。不加模型sign-off工具、第二Agent Loop或Evidence数据库，Pi原生能力与默认chat-first/PDF-only入口保留。
- Canonical Evidence读取原Answer/selection记录及原Locator/scope，验证journal/schema/身份/内容hash；host复验scope owner、当前source权限与原conversation。Answer来源必须经过私有publication和同一completed ControlStore/Pi checkpoint，孤立manifest/Note正文/Recall/profile/树摘要均不能冒充Evidence。
- 历史审阅frame由用户明确选择并封存；其current检查约束本次人类工作面，不改变native source admission、不重新消费选区、不将旧Atom改成新scope。私有枚举接口只给host重新授权后组装有界列表；截断状态不伪装完整材料。
- 全product command的SHA进入Core既有幂等输入；标签页outbox冻结actor/workspace/conversation/binding/generation/scope与原body/key，刷新不自动执行。同键不同完整body不能因投影后相同而复用receipt；成功回执严格匹配后才清理原草稿。
- derived gate沿真实输入Claim边检查接受/current/原scope等有效性，不对previous/successor历史一概判错；Review后输入被替换时Publish再拒绝。Review所消费的完整Claim闭包先授权；冻结Artifact读取不无条件展开未来版本。不是算术表达式执行、自动不确定性传播或语义蕴含证明。
- 产品要求精确Review的最新journal追加顺序人类批准，同毫秒也不按ID/time排序；后续拒绝禁止旧批准发布。已有publication允许原body/key/Review/sign-off组合对账其旧receipt，新键仍失败于draft CAS，不撤回或重写已发布历史；legacy不自动获得此额外产品策略。
- 修正工作面Review/Artifact按ID排序的问题：snapshot改按已验证journal追加/首次创建顺序，发布不移动已存在Artifact的位置，旧独立Artifact枚举排序保留。Core canonical21/21含同timestamp/逆字典序/重复读取/重开/篡改回归；Web最新Review选择也有独立测试，避免旧Review覆盖新审阅结果。
- 客户端三个review方法在请求、响应及hash计算后复核actor/workspace/conversation/binding/generation/runtimeSession/epoch；旧请求的401不再清除新配对身份。28项client回归通过；非字符串/非opaque ID和错误动作回执均拒绝。
- 已知定向验证：Core应用14；canonical Evidence/相关store gates组合51；host10；Web state/UI17与client28合跑45/45；共享Node/static browser90与Python shape/classification90。分组可能重叠，不相加宣称整体验收。
- actual HTTP/Pi integration 1/1 passed（23.36s，journey 19.47s）；新增真实browser旅程1/1 passed（39.3s）。真实PDF/Read/Pi/认证/持久存储/原件；browser含Brief+Matrix、提交成功但丢响应→原键重放、reload、approve→reject阻止发布→fresh approve。供应端显式faux，不冒充真实模型质量或人工视觉验收。
- `bash scripts/pnpmw exec playwright test --config playwright.live.config.ts`：20/20通过（4.8m）；`bash scripts/pnpmw exec playwright test --config playwright.demo.config.ts`：14/14通过（1.1m）。最后身份/审阅顺序修补与统一构建后，`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/reviews.pw.ts`再验1/1（47.8s）；这是已计入live20的一项，不重复计数。
- `bash scripts/verify_sources.sh`：10个只读source校验通过；PageIndex HEAD/main本轮复核仍为ae169566b3148792776531d987f543edcad92321，Flash既有raw/merge与summary/expand/full保留，不虚报新上游提交。无付费模型调用、未启动4177常驻服务。
- 首轮`bash scripts/check.sh`：JS 145文件通过/1文件失败，1739 passed、1 failed、1既有opt-in skipped（208.42s）。唯一失败为旧DSH M4测试只内存activate来源范围、未走真实入口的immutable scope commit；canonical resolver正确拒绝缺少持久scope的Evidence。补齐测试准备流程，`bash scripts/pnpmw exec vitest run plugins/docatlas-dsh/test/m4-runtime.spec.ts`1/1（6.11s），且该用例在第二轮全量中通过；没有降低Core/host证据验证。
- 检查流程加速：根`check:js`改为显式sidecar校验→有序拓扑单次build→无重复hooks的typecheck→完整测试/打包/兼容/协议；独立package命令和`.npmrc`不变。第二轮日志确认7个package各build一次，完整typecheck通过且无递归构建。构建层内并发2、类型检查4，测试保留原并发4及所有断言/期限，不引入新runner/依赖、不虚报加速倍率。
- 第二轮`bash scripts/check.sh`：环境、生成contracts、109 packaged files、lint、单次拓扑build与所有typecheck通过；JS为145文件通过/1文件失败，1739 passed、1 failed、1既有opt-in skipped（189.68s）。唯一失败stack明确落在旧`linux-executor.spec.ts`启动flag的默认1000ms `expect.poll`，不是15s整体测试期限，也没有生产失败证据。只将该测试改为等待真实Bash stdout经Pi发出的ready事件，并检查flag内容/实际active进程；总期限、取消/落盘断言及无retry保持。
- 受影响`bash scripts/pnpmw exec vitest run apps/server/test/linux-executor.spec.ts`完整9/9补验（34.94s）；直接server `tsc --noEmit`与该文件lint通过。未重复构建或再次重跑未改的全部JS测试，以上是全量加定向补验的结果，不声称第二轮脚本整条最终exit0。
- 按原脚本续验：`check:plugin`/`check:compat`/`check:protocol`通过（含Pi24文件补丁）；`uv run --locked --project python/docatlas-sidecar`的ruff check、ruff format --check（50文件）、mypy（24源文件）、pytest全量872/872（122.52s）通过；同项目`python scripts/vendor_flash.py --check`通过82文件/25函数；`bash scripts/pnpmw exec node scripts/verify-packed-flash.mjs`通过81文件及provenance。接续命令组最终exit0。
- `bash scripts/pnpmw exec playwright test --config playwright.config.ts --workers=1`：旧DSH6/6（22.9s），在native/Python测试全部结束后单独运行；三套浏览器共40个不同用例通过。既有大chunk及旧border/borderColor样式warning保留，本轮不顺带重写旧UI。
- 12份更新文档的99个本地文件链接检查通过；没有遗留本轮测试/构建进程，也没有启动4177常驻服务。
- R4-002及完整目标继续in-progress；Continuity、自动学习/Probe、真实业务/算术与原生parity、迁移恢复/公网发布未因此完成。

### 2026-09-09 · 持续目标第十八批：真实偏好应用与研究Core提取

- 按用户再次加速要求并行：Core偏好应用/真实Pi集成、broker模型接缝/v2/Web、ClaimReview Core/独立审阅；主线程装配host/HTTP、集成与统一构建。完整目标保持active，不重新调研非阻塞Flash选项。
- ADR-043：固定六轴、ordinary/disclose、exact consumed source/binding；仅host追加systemPrompt，不改native消息/工具/提交与事实域。首个真实非空正文观察才写MemoryUse，outcome unknown；旧v1不改语义，v2显示真实连接/生成阶段含义，原v1 outbox按原键版本对账。
- 关闭/暂停/修改/遗忘或失效会中止受影响生成并阻止同submission隐藏重跑；contribute-only/export/幂等receipt不撤销。保持approved payload hooks可见最终模型payload，并如实说明外部副本/模型输出不由forget撤回。
- ADR-044：ClaimReviewApplication仅Core port，既有9个M4方法、真实human hydration/签批、历史scope与canonical Evidence权限；无新增store、无模型human权限、未宣称产品Claim/Review/Publish UI可用。
- 定向验证：初始broker/peer/Luna68、Core偏好9+store10+controls6、ClaimReview5通过；追加purpose18+policy39+peer8共65通过，epoch/migration与既有store/controls共22通过。最后host/Web/contracts组合266通过，epoch版v2共享Node/browser与Python各77通过；server/runtime/Web/E2E类型检查与lint已收口。
- 独立审阅找到并修复三个实际边界：旧frame回调覆盖新撤销标记、provider结束后的native工具间隙撤销漏标、自动压缩误作回答生成。用途以原生context+signal一次性关联/isCompacting判别，不改Pi patch；revocation按submission保留并跨工具间隙生效。
- 另实证修复擦除后的旧outbox复活：profile元数据v2持久epoch、事务内校验、v1备份迁移/已擦除库非零起点；旧v1/v2请求不得跨擦除重建设置或useExisting，最新擦除receipt可精确对账。Web保留旧请求而不换epoch，需用户明确清除草稿并重新选择。
- 真实隔离Pi/HTTP集成5/5（27.76s）：实际provider临时指导/MemoryUse、原生JSONL/恢复无注入、关闭/暂停/忘记/重启、生成中及native Bash间隙撤销、不回滚已完成工具写入、原键不重跑；实际SDK自动compaction的summary无指导且不计使用。测试用有界faux长回答触发原生压缩，不用手动RPC冒充自动流程，不代表真实模型质量验收。
- 新frame测试初次误把调用两次幂等record等同重复写入；改为断言第一次created、第二次replayed，持久scope仍同一份，并验证不激活文档scope/排队不生效/取消失效。没有放松源码授权或用自动重试掩盖失败。
- `bash scripts/verify_sources.sh`：10个只读源干净；在线PageIndex HEAD/main仍为ae169566b3148792776531d987f543edcad92321。Flash vendor/raw-merge/显式增强能力保持，不虚报新的上游变化。
- 第一轮`bash scripts/check.sh`在JS测试阶段退出：1557 passed / 7 timed-out / 1既有opt-in skipped；7项均为既有5s/30s wall-clock超时，包含旧证据/原生边界和新偏好fixture，无断言不符。共享宿主当时load average 61.52；将重型测试并发8→4复验，全部用例、原超时阈值和断言保持，未跳过失败或删除材料，也未触碰其他用户进程。
- 第二轮`bash scripts/check.sh`：JS 140文件、1564 passed / 1既有opt-in skipped（160.04s）；环境/生成合同/109 packaged files、lint/typecheck/build/DSH打包/跨语言协议/Pi24文件补丁全部通过。Python为781 passed/1 failed，唯一失败是旧M0目录枚举测试漏列新增product-personalization-v2，不是业务parser拒绝。补齐该测试枚举后按脚本剩余阶段复验，没有重跑未改动的JS构建；不将此记录冒称整条脚本最终exit0。
- 接续执行：`uv run --locked --project python/docatlas-sidecar pytest python/docatlas-sidecar/tests` 782/782（111.63s）；ruff check、ruff format --check（49 files）、mypy（24 source files）通过。`uv run --locked --project python/docatlas-sidecar python scripts/vendor_flash.py --check`通过82文件/25函数；`bash scripts/pnpmw exec node scripts/verify-packed-flash.mjs`通过81源/数据/license文件及provenance。
- 新产品浏览器：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts` 19/19（4.1m），含原始PDF引用/对照/选区/跨会话Note、真实生成why-used、旧v1原键重放及跨标签页擦除epoch；`bash scripts/pnpmw run test:demo` 14/14（1.0m）。仅显式faux模型，不宣称真实模型质量或人工视觉验收。
- 旧DSH浏览器前两次各5/6：`test:browser`（2 workers）及`playwright --config playwright.config.ts --workers=1`均首条空root；trace显示localhost模块请求被Chromium以ERR_NETWORK_CHANGED中止，无HTTP500或Vite转换错误，不能仅凭trace断言机器外网改变。其他测试完全结束后，`bash scripts/pnpmw exec playwright test --config playwright.config.ts --workers=1`原源码/原阈值6/6（20.7s）；未加自动retry或放宽断言。最终浏览器39/39分别通过，既有大chunk/border样式提示保留。
- 12份更新文档的92个本地文件链接检查通过。本批无付费模型调用，未启动4177常驻服务。完整目标/R4–R7继续active；自动习惯学习、Probe、产品Claim/Review/Continuity、真实语料/模型效果和完整恢复发布仍未完成。

### 2026-09-09 · 持续目标第十七批：可交互研究与偏好控制

- 上一goal turn为progress；本批按用户加速要求并行完成Compare/Notebook UI、Core/Pi research与显式偏好controls，主线程收口契约/领域权限/HTTP/原文resolver/集成。完整目标继续active，不把控制面完成当自动个性化完成。
- ADR-041：复用v5 Investigation journal和既有wire；私有ResearchJournal保存真实native call身份，Core capture snapshots支持无文档研究/被显式保存的选区，但不绑定Agent文档scope。普通Pi任务不因研究容量被阻断。查询前过滤权限，orphan不能先通过preview暴露，raw checkpoint关联源仍只作候选。
- ADR-042：profile按actor+workspace隔离，服务端注入身份；显式6轴、CAS/双开关/暂停恢复/忘记导出与实际why-used。HTTP/UI明确modelApplication=not-connected，未写假MemoryUse，也未启用Probe/自动学习。
- 多文档A/B、独立cursor/selection/返回栈与窄屏切换；Notebook全文而非preview编辑、原件重验、soft-delete历史保留，mutation outbox先保存原键，刷新不自动重放。共享Drawer键盘遍历包含select/summary且排除disabled。
- 集成前定向：Core研究15、Pi桥5、capture snapshots19，偏好Core6/host5/Web10、Notebook9；新两套共享TS/browser与Python各282用例通过。原有store/Answer/application的39项回归、追加14项Core store回归与全局lint通过。
- 真实产品/隔离Pi研究链已通过：实际docatlas_record→private provenance/domain→正常关闭/重开→新conversation docatlas_recall，faux provider累计4次调用，无历史重放；不是付费模型的研究效果评测。
- `bash scripts/check.sh`最终exit0：131个JS文件，1378 passed/1既有opt-in skipped（106.66s）；705 Python passed（110.11s）。环境/生成合同/109 packaged files、lint/typecheck/build/ruff/mypy、旧DSH打包/协议、Pi24文件补丁、Flash82文件/25函数及实际pack全部通过。
- 真实Notebook集成暴露并修复：legacy nonce须`seln_`+32字符、首建Note上限4000（编辑仍8000）、lifecycle请求须保留原scopeVersionId。测试先前还错误假设默认研究贡献关闭，现显式通过UI关闭后再验证手动保存；不把测试假设错当产品策略变更。
- 首轮live为14/16；上述修复后Notebook两条真实链路2/2（51.7s），相关完整定向173/173通过。一次中间检查与build重叠读到旧validator/临时缺失dist，停止重叠后在已完成构建的产物上复跑；未放松断言或加自动重试。
- 最终浏览器：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts` 16/16（3.8m）；`bash scripts/pnpmw run test:demo` 14/14（1.0m）；`bash scripts/pnpmw run test:browser`旧DSH6/6（22.4s），合计36/36。包括真实原件/Compare/选区/跨会话Note、丢包不重复写、偏好CAS/导出/忘记与原型可访问性；模型仍为faux，不冒充业务效果或人工视觉验收。
- 原有大chunk与`border`/`borderColor`提示保留。12份更新文档的164个本地文件链接检查通过。本批不调用付费模型，也未启动4177常驻服务。下一批优先偏好应用/MemoryUse/Probe与研究Continuity/Claim/Review；完整个性化仍未完成。
- `bash scripts/verify_sources.sh`验证10个只读源干净；在线PageIndex HEAD/main仍为ae169566b3148792776531d987f543edcad92321。Flash既有raw/merge与显式增强保留，本批未改vendor或数据锁，不虚报新上游优化器。


### 2026-09-09 · 持续目标第十六批：真实引用与本机入口

- 实现ADR-039：精确native toolCallId+宿主持久ReadResult→同一已核验checkpoint prefix→Core AnswerManifest→completed publication link。canonical manifest仍在SourceScopeStore，不另造领域真相。未知/旧轮次/locate/树/worker自报metadata不能创建可点击证据。
- product-answer共享wire/consumer校验、host private AnswerReceipts、authenticated GET/focus、独立cache-only resolve与actual join；Web双hash绑定，仅read-verified按钮，同版PDF unique quote高亮，歧义/page-only明确无框。选区/普通Pi原生任务/旧DSH保留。
- 实现ADR-040：`bash scripts/run-docatlas-web.sh` 启动独立本机beta，127.0.0.1:4177、一次性配对、独立state、空会话不调用模型、资源精确hash审批、clean native恢复。居中聊天，历史和PDF按需展开；没有默认公网开放或faux fallback。
- Azure GPT-5.6 Luna走Pi ModelRuntime公开Responses provider，token不写DocAtlas文件/worker/native，固定HTTPS、store:false、4并发、取消等az实际close。OpenAI Docs核验模型能力/reasoning映射；参考费率不冒充Azure账单。
- 真实联调找到Responses省略strict会强制填满可选字段，Read混入其他mode参数而失败；明确strict:false恢复原Pi参数语义，不放宽Core union。修复前跑到预算即停止；修后同预算3次真实模型调用通过完整引用smoke。
- `bash scripts/pnpmw exec node scripts/test-pi-azure-luna.mjs --live`：PI_AZURE_LUNA_OK；`... scripts/test-pi-pdf-live.mjs --live`：PI_AZURE_LUNA_PDF_CITATION_OK（3 calls、completed checkpoint、attested citation、physical page2原件/精确quote一致）。探针自身两次字段/季度问题设置错误已修，未将其当产品故障修复或质量退化。
- 最终 `bash scripts/check.sh` exit 0：118 JS files、998个可执行JS测试、423 Python passed（102.36s），全部build/lint/typecheck/打包/协议/Flash与Pi兼容通过；既有opt-in skip保留。末尾JS摘要在工具输出中被截断，另用`vitest list --json`核对当前998个测试/118文件，不使用包含旧条目的cache计数。
- 浏览器最终：`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts` 11/11（2.3m）；`bash scripts/pnpmw run test:demo` 14/14（59.0s）；`bash scripts/pnpmw run test:browser` 6/6（20.7s）。真实API模型smoke与faux模型的浏览器覆盖分开陈述，不把合成PDF当业务语料评测。
- 实际CLI在4177启动：首页200、未配对`/api/bootstrap`为401；Ctrl+C输出正常关闭，测试服务已停止，没有留下常驻部署。真实application首屏/手机截图保存于`.cache/product-beta-{landing,mobile}.png`，无横向溢出；图像查看工具未能展示，不据此宣称人工视觉验收。
- SSE诊断中Chromium的EventSource在1–6秒持续OPEN/“实时连接”，仅一次200、open+initial resync、无error/重连、0模型调用。收尾将初始同步窗口共用的reconnecting文案改为“正在重新同步”，不再误报断线；仅改显示，`bash scripts/pnpmw --filter @docatlas/web-demo typecheck`、`bash scripts/pnpmw exec oxlint --deny-warnings apps/web/src/live/LiveApp.tsx`、`bash scripts/pnpmw run build:demo`均通过，既有大chunk提示保留。4份收尾文档的33个本地文件链接核对通过。
- 10个read-only source checkouts干净，PageIndex在线main仍ae169566；未stage/commit/迁移用户旧库。操作方法见[本机指南](product/local-web-beta.md)，证据/已修问题见[记录34](../research/34-product-citations-and-local-entry.md)。完整目标继续，下一批优先B层多文档/研究积累/个性化，以及实际使用反馈和剩余发布门槛。

### 2026-09-09 · 持续目标第十五批：Flash增强与并行集成

- 用户要求加速后，浏览器修复、Pi导航、共享合同三路独立实施，主代理负责Answer纯编译迁移与统一构建。主计划v0.7明确先交付可用阅读主链，再接研究/个性化与完整发布；完整目标仍active。
- 显式summary/expand/full作业：独立overlay、整项页/节点/模型/字符/token/时长预算、原文标题校验/严格cost下降、bottom-up/source-excerpt。Pi ModelRuntime单次无tools，不另起Agent Loop，不改上游vendor/canonical tree/FTS/Evidence。
- EnrichmentJobs持久claim、queued显式启动、terminal幂等读取、取消实际join；主Pi只读docatlas_enrichment列出/分页读完整节点。active frame、原件/表征hash在异步前后重核；旧completed结果包括幂等accept入口均不能绕过freshness。unclean接管、失败用量ledger/retention仍待。
- Live空树故障定位为无可识别目录的真实PDF，非HTTP失联；修复空树提示/禁用按钮，新增带真实书签PDF验证非零模型调用与刷新不重复生成。不存在目录不等于没有正文。
- 六种enrichment wire union新增共享27正例/71形状反例/46语义反例；TS/browser146通过、Python145通过。日期反例找到Python可选date-time校验缺失，固定rfc3339-validator并更新两份manifest/uv.lock，未删除失败用例。
- Answer算法迁至Core/evidence，DSH标准事件adapter保持等价，15项新旧编译测试通过；不是Pi引用已接通。模型单次请求/取消join/输出预算/权限撤销6项通过。
- `bash scripts/check.sh`最终全过：109 JS files、831 passed/1 skipped（97.14s），356 Python（103.08s），lint/typecheck/build/ruff/mypy、109 packaged files、DSH package/协议/Pi24文件兼容、Flash82文件/25函数及实际pack。首跑新导航test省略scope字段导致类型失败，补全真实scope fixture后复跑；首次定向Pi toolResult偶发失败未定位，独立/整文件及完整JS重跑通过，不据此宣称根因已修。
- `bash scripts/pnpmw run test:demo` 14/14（1.1m）、`bash scripts/pnpmw run test:browser` 6/6（22.6s）、`bash scripts/pnpmw exec playwright test --config playwright.live.config.ts` 最终9/9（2.0m）通过。Live首跑8/9，失败在测试读取Chromium已失效响应缓存，页面实际已有六节点；改为route.fetch原样转发并保持原断言后全套重跑通过，额外 `tsc --project tsconfig.e2e.json --noEmit` 与该文件oxlint通过。既有live大chunk/旧border提示仍保留；faux模型不等于Azure质量验收。
- `bash scripts/verify_sources.sh` 10个源checkout干净，PageIndex在线main仍ae169566；source/packaged双uv locks同步，7文档/95个本地链接检查通过。
- 未默认部署、未stage/commit、未迁移删除用户历史。下一关键路径：Pi checkpoint/read-backed Answer→原始PDF可信引用及启动入口；R4–R7、真实模型与中文/OCR/复杂文档质量继续。详见[记录33](../research/33-flash-enrichment-jobs.md)与[ADR-038](adr/038-flash-enrichment-jobs.md)。

### 2026-09-09 · 持续目标第十四批：产品选区核验与一次性消费

- 前轮为progress；本轮新增Core同页Unicode scalar验证器、SelectionTickets/ProductSelections、live文字选区托盘，目标仍active，不把文字选区等同全部R3或引用证据。
- 选择的Library revision/hash/page与全文字位置同源验证；仅归一排版空白，不模糊重锚。多文档组含坏成员时无部分ticket；准备绑定整组submission ID/request hash，native消费重核source/policy/expiry后事务consume。另一个submission不可复用；取消/失败不按TTL解锁已绑定票据。
- 私有SQLite ticket有schema/identity/hash检查，15min、8票据/整组8000字符/1024容量。每个stage独立cache-only sidecar，排除import grants；取消等实际namespace join才释放四个验证槽之一，延迟join测试证明不能靠连续取消扩容。历史DSH marker/service与Evidence journals不迁移、不重写。
- Live显式核验/加入/撤销/本地忘记/回原文；stage回包丢失后原键刷新重试，uncertain submission冻结票据和sources。核验中不允许抢先发送；matching receipt才清one-shot引用，下一问题保留sources但不自动重复选区。持久问题与native enriched输入分层显示，不另造对话历史。
- 真实浏览器验证PDF.js选区→stage丢包刷新→托盘→原文高亮→隔离Pi model input→consumed；faux仅模型。手机390宽axe和无横向溢出通过，截图已产出但图片工具仍无法呈现URL，未冒充人工视觉验收。
- 新增测试覆盖票据全组原子性/重开/foreign binding/另一个提交/已消费/过期成员不改另一成员/存储hash篡改、Unicode/歧义/截断/hash漂移、真实多文档与晚policy撤销、outbox恢复。消费回调失败后model调用0、native joined、outcome-unknown。
- 旧native测试重复暴露混合限额竞态：同一800ms误覆盖Node启动、输出/手动stop/恢复断言。拆为独立800ms截止与输出/手动取消测试，并在ready等待中接住提前退出；生产限额与namespace join断言未放松。
- 最终 `bash scripts/check.sh`通过103 JS files、664 passed/1 skipped、211 Python（99.42s），lint/typecheck/build/ruff/mypy、109 packaged files、DSH/preset/protocol、24 Pi fingerprint、Flash82文件/25函数与实际pack校验全部通过；新增测试的类型/fixture问题已修正后完整复跑。
- Browser live7/7（1.2m，最终cache-only配置）、原型14/14（59.9s）、旧Reader6/6（20.6s）；额外选区手机/截图case通过（20.6s）。旧border警告和live静态validator导致>500k chunk警告仍记录，没有提高警告阈值隐藏。
- frozen pnpm/双uv locks、10源checkouts、11文档/137链接通过。PageIndex在线main仍ae169566；重新检查Flash README，summary/expand明确需要模型，仍要Pi-governed job/budget，不在Python私带凭据。vendor未改。
- 未stage/commit、未默认部署、未迁移删除用户历史。继续Answer/citation验证、pin/region/Compare/全入口、版本/GC、R4–R7以及Flash模型增强与质量评估。详见ADR-037/research32。

### 2026-09-09 · 持续目标第十三批：live PDF准入与原件

- 前轮为progress；本轮真实PDF upload→Library commit→明确revision选择→隔离Pi/Flash merge/Read→checkpoint→同版原件已接live，仍不是结构化证据/选区/全部目标验收。
- UploadStore独立metadata/bytes grants，25MiB/文件、256 reservations与512MiB/actor/workspace上限，2传输并发；逐块hash/长度、fsync后stored，Library事务成功后才eligible。同名不同内容不覆盖，exact bytes复用；无browser路径或generic RPC入口。
- staging按reservation固定exclusive路径，普通中断仅清自己创建的part；崩溃遗留/其他进程part不覆盖、不按TTL删除。已接收Library queued/running import显式重试保持原ingestedAt恢复，不自动运行模型。永久数据GC/删除、崩溃遗留人工恢复与显式版本替换尚待。
- Live资料drawer含上传/继续处理/失败/分页/版本checkbox；refs冻结进submission/hash，uncertain outbox恢复同一来源。PDF.js source类型去Demo依赖，stream限长与hash校验，同版原件并排/手机切换，草稿保留。原文浏览不是selection authority。CSP只增加self worker及Wasm所需wasm-unsafe-eval，不开放JS unsafe-eval。
- Browser真实上传fixture调用docatlas_sources→Flash merge→Read page，最终模型上下文含实际tree-page与原文15.2。faux仅模型，未冒充真实质量。含PUT回包丢失后刷新/继续导入、foreign/stale原件拒绝、坏PDF不准入/草稿保留/零模型调用、手机axe与无横向溢出、无CSP违规。
- `bash scripts/check.sh`最终通过101 JS files、649 passed/1 skipped、206 Python（98.60s），lint/typecheck/build/ruff/mypy、109 packaged files、DSH/preset/protocol、24 Pi fingerprint与Flash82文件/25函数/真实pack。新增document-http Node/static browser/Python正反例及catalog集合检查。
- 首轮新schema遗漏Python catalog集合、e2e局部document变量遮蔽已修正；并行browser负载下旧native 800ms测试曾触发时限，单独完整复跑通过，未改生产/测试deadline。原型14/14（58.8s）、旧Reader6/6（20.8s）、最终built live6/6（59.9s），含增强PUT丢包/CSP两文档场景。
- frozen pnpm/双uv locks、10 source checkouts、10文档/131链接通过；在线PageIndex main仍ae169566，vendor未改，本轮接其实际merge导航，不虚称summary/expand新增。未stage/commit/默认部署或迁移删除用户资料。
- 继续结构化Answer/verified citations/selection票据、多入口@PDF/Compare/完整Library、版本/删除/GC、崩溃监督与默认launcher、R4–R7和Flash显式增强job质量评估。详情ADR-036/research31。

### 2026-09-09 · 持续目标第十二批：管理器、创建与原生恢复

- 前轮为progress；本轮新增RuntimeCatalog/RuntimeManager、封存原生文件恢复、POST conversation-create及live新建入口，整体目标仍未完成。
- catalog在启动前持久claim，只有实际namespace/native join、文件+目录fsync后才能clean释放；跨连接unclean claim不因PID/TTL猜测接管，owner token仅存hash。最大活动runtime受配置上限控制，不以自动关闭可信扩展来隐藏资源限额。
- 正常关闭后严格核验原JSONL UTF-8/header/version/cwd/session/拓扑/全文件seal，官方SessionManager.open恢复同一路径与entry IDs、模型/context；旧completed/cancelled请求不重跑。已停止的native上下文保留；未知/dispatch前后语义分开。缺文件/篡改拒绝，不重新seal洗白。
- 真实隔离Pi测试关闭旧worker与所有store handles后重开；第二轮模型输入包含第一轮user/assistant和新问题，旧字节不改、文件仅追加。取消后恢复也未重跑旧请求。另有claim伪造/拓扑/UTF-8/foreign identity阴性测试。
- 浏览器创建键按actor/workspace绑定，响应丢失后同键重试只创建一个会话；切换、刷新所选新会话正常。Browser无路径/provider/approval配置权，Node/Python/browser共享创建合同正反例。
- 全量首次暴露真实SandboxProcess竞态：grace timer在namespace仍存在时过早杀monitor。现保留reaper直到已知namespace消失/换identity，新增确定性timer测试，原0/1/10/100ms实际PID移除断言保持且通过；未以放松取消证明修复测试。
- `bash scripts/check.sh`最终通过99 JS files、638 passed/1 skipped、199 Python（100.05s），lint/typecheck/build/ruff/mypy、109 packaged files、DSH/preset/protocol、24 Pi fingerprint、Flash82文件/25函数及pack验证。上下文spy采用已构建test helper顺序验证，避免并行构建时读旧lib。
- Browser最终原型14/14（1.0m）、旧Reader6/6（20.0s）、managed live4/4（28.3s）；模型为明确faux。旧border warning仍在。frozen pnpm/双uv locks、10 source checkouts、10文档/128链接通过；在线PageIndex main仍ae169566，vendor未改。
- 未部署默认listener、未stage/commit、未迁移/删除用户历史。异常主进程死亡监督/核验、完整branch/history/close控制、默认launcher、upload/Reader/selection/Answer、R4–R7与Flash增强质量评估继续，不将clean reopen等同完整崩溃恢复。详情ADR-035/research30。

### 2026-09-09 · 持续目标第十一批：真实配对聊天页

- 前轮为progress；本轮新增独立live.html真实客户端与conversation listing，保留原型index/DemoApp、旧DSH和用户数据。未切默认launcher/部署；整体目标仍未完成。
- 同源配对、当前actor/workspace列表/分页、snapshot/SSE、普通/steer/follow-up、实际停止、saved/provisional/unknown提示、注销已接产品HTTP。无Demo答案fallback。所选会话刷新恢复；epoch丢弃旧响应/观察。
- 草稿/不确定请求的原body与key按tab+actor/workspace/conversation保存；重连不submit，用户明确原键重试。匹配hash/generation/conversation的durable receipt才清空；SSE先到ack、logout后迟到数据、logout确认前重配对都有测试。CSRF/配对码/模型凭据不进tab storage。
- Browser validators由canonical schema生成静态ESM。实际浏览器查出AJV默认导出互操作问题并修复；字体外置self，未开放eval或削弱CSP。产物生成检查扩展到browser/TS/Python。
- `bash scripts/check.sh`最终通过97 JS files、624 passed/1 skipped、195 Python（95.06s），lint/typecheck/build/ruff/mypy、109 runtime files、DSH/preset/protocol、24 Pi patch文件、Flash82文件/25函数与真实pack验证。首跑旧native marker默认1秒readiness在负载下失败，改为明确5秒ready等待；生产超时及1/10/100ms取消断言不变。
- Browser原型14/14（58.4s）、旧Reader6/6（22.1s）、live最后3/3（20.0s）。Live使用真实隔离Pi/HTTP/native checkpoint、明确faux model，包含响应丢失后原键重试一次、实际abort、脚本字面量不执行、1440/768/390 axe/无横向溢出。桌面/手机截图已生成；当前图片工具未能呈现，不将截图产物当人工视觉验收。
- frozen pnpm/双uv locks、10 source checkouts、10文档/125链接通过；09-09在线PageIndex main仍ae169566，vendor未改。未stage/commit，目录仍未跟踪。源码无临时pair诊断日志；失败trace仅含已销毁测试服务的凭据，仍按私有测试产物处理。
- 继续持久runtime/会话管理、完整恢复、upload/Library/Reader/selection/Answer/controls，以及R4–R7和Flash增强评估；不将当前通用聊天入口当PDF研究全闭环。详情ADR-034/research29。

### 2026-09-08 · 持续目标第十批：SSE与checkpoint-backed快照

- 前轮为progress；本轮接认证snapshot/events端点与ConversationObservations，未部署listener或将原型切换成live产品，完整目标未完成。
- generation/epoch/sequence游标、有界256事件/1MiB replay、最近32条receipt翻页、provisional text/tool活动与核验native history明确分开。旧/缺失游标resync，断线不重跑/不取消；每帧auth+binding复核、logout关闭与idle过期检查。
- Worker runtime.submit消费/进度分开，Pi实际消费决定submission归属；message live IDs避免混流。relay缓冲受限且不在模型callback等待浏览器；slow/failing observer退出而native继续。
- 同一verified file prefix产生过滤文本投影，拒重复/缺失/cyclic entry；不转发thought/provider/system/tool payload/session path。bounded history/text明确标记；完整历史/失败native投影/cold restore仍待，不把live草稿标saved。
- 真实隔离Pi+loopback HTTP测试通过：流式前缀→完整snapshot答案→receipt/checkpoint；SSE重连不增加model calls、断开观察不取消等待模型、stop才停止、logout关流。模型为faux；没有宣称真实回答质量。
- 额外单测：10k burst relay、response缓冲上限、observer抛错、ring淘汰、跨epoch/generation/actor、late progress、伪receipt callback、同toolCallId跨submission与recent分页。新增15组TS/Python shared shape/semantic fixtures。
- `bash scripts/check.sh`最终通过93 JS files、592 passed/1 skipped、195 Python（101.89s），lint/typecheck/ruff/mypy/build、109 packaged files、DSH/preset/protocol、24 Pi fingerprint、Flash82文件/25函数与真实pack验证。首轮唯一失败为测试假设整句属于一个delta，已按真实chunk/provisional边界修正，同时保留完整snapshot答案断言。
- Browser单独6/6（20.8s），旧border warning仍在；frozen pnpm/双uv locks、10 source checkouts、9文档/118链接通过。PageIndex main在线仍ae169566，vendor未改。未stage/commit，目录仍未跟踪。
- 下步认证前端与SSE reducer/重连UI、完整history/cold restore、upload/Reader/selection/Answer和controls/approval；R4–R7不缩小。详情ADR-033/research28。

### 2026-09-08 · 持续目标第九批：统一namespace与自有HTTP命令

- 前轮为progress；本轮将早停保护推广到Pi/native/document/tree与Python PDF/Flash，并接首个paired HTTP认证/提交/回执/停止链。整体目标仍active，未开放默认listener、未部署Web、未迁移用户数据库。
- 共享Node SandboxProcess使用私有info-fd和child parent/start-time；停止namespace后让monitor回收，done再核查namespace退出。0/1/10/100ms、空/坏UTF8/过大/外来PID、Pi启动时撤销、两个document命令立即停止覆盖实际路径。
- Python standalone缺os.pidfd_open，采用明确Linux x86_64/aarch64 syscall封装；真正pidfd kill/select后等待monitor回收。4个立即停止重复测试；PDF文字/像素/geometry与Flash raw/merge/65页继续等价。source vendor未改。
- product-http.v1有11组TS/Python shared fixtures；单用5分钟配对码、hash bearer/HttpOnly cookie、会话CSRF/expiry/logout/容量上限。精确Origin/Host与loopback/TLS、body/time/concurrency限制，拒伪actor/另一workspace/坏UTF8/超限/query秘密/replay/重复cookie。
- 真实loopback HTTP集成使用独立Pi和native执行：202持久接收→真实checkpoint回执；幂等重复不增模型调用；实际第二模型调用被停止并确认quiescence。faux只代表模型，不把它当答案质量或部署证据。
- `bash scripts/check.sh`最终通过90 JS files、571 passed/1 skipped、180 Python（90.51s）、lint/typecheck/ruff/mypy/build、108 runtime files、DSH/preset/protocol、24 Pi patch文件、Flash 82文件/25确定函数与真实pack校验。frozen pnpm/双uv locks和10个source checkouts通过；PageIndex main在线仍ae169566。
- Browser并发首跑5通过/1点击超时；检查trace后同代码单独重跑6/6（21.3s），未修改UI、断言或timeout；原border warning仍在。11文档/116本地链接通过；未stage/commit，目录仍未跟踪。
- 下一步SSE/会话快照/重连、认证前端、上传/Reader/选区/Answer、完整controls与审批UI；其余R4–R7未缩小。host death/cgroup/cross-platform与整体验收仍待。详见ADR-031/032和research27。

### 2026-09-08 · 持续目标第八批：扩展exec与内容资源审批

- 上轮为progress；本轮增加loader-scoped pi.exec、原argv/分流输出/真实取消结果、resource-trust.v1、ResourceStore和RO快照。整体目标未标完成；无HTTP部署或用户DB迁移。
- 保留原20个SDK补丁文件，新增4文件接通factory前exec seam；v2 fingerprint + frozen pnpm install/dual uv locks通过。缓存/inline/pre-trust仍使用当前runtime，原生无配置fallback未替换。
- 私有API按actor/workspace/实际reviewed hash审批，512文件/32MiB、fd-relative/O_NOFOLLOW、稳定源重验、fsync/rename、SQLite FULL事务；跨workspace/过时hash/credential文件/symlink/oversize/篡改/坏row拒绝。审批撤销停止live worker/model/effects，unknown不重放。
- Native与Pi只读挂载同一批准资源，原始目录新增auth文件不可见；技能/helper可读，代码不可写。发现并修复早停bwrap monitor后namespace/stdio存活竞态；LinuxExecutor校验info-fd child PID/start-time并杀整个namespace，1/10/100ms截止纳入测试。
- `bash scripts/check.sh`最终通过：86 JS files，544 passed/1 skipped，165 Python（93.55s），typecheck/ruff/mypy/build、107 packaged runtime files、legacy/preset/protocol、24 Pi指纹文件、Flash 82文件/25函数与真实pack。另定向coordinator 7/7通过。
- 旧heartbeat的300ms wall-clock依赖在负载下失效；改共享显式lease/checkpoint clock，真实timer逐步续租且finally释放gate。产品30s租约、过期fence与checkpoint时间校验不放松。
- Browser 6/6（21.4s）；旧border warning未借本轮改动清理。10来源checkout干净、PageIndex main在线复核ae169566。10文档/115本地链接通过。未stage/commit，目录保持未跟踪状态。
- 下步继续其他launcher的启动PID保护、项目/package/approval UI、完整controls/provider/egress/后台/额度，以及R2–R7。详情ADR-030/research26；不是全功能或完整安全认证。

### 2026-09-08 · 持续目标第七批：独立Pi与宿主brokers

- 前轮为progress；本轮新增真正运行公开SDK的Pi worker、worker-frame.v1及model/native/document桥、宿主checkpoint核验。完整目标未改、未标完成，没有开放HTTP服务。
- 真实集成4场景：原生7工具+global扩展+宿主model PID+checkpoint；模型取消后新提交；真实PDF/Flash/page/image；副作用后SIGKILL进入unknown且不自动重放。没有把faux模型当实际回答质量。
- 方向method maps、monotonic ID/流顺序/UTF8/帧/并发与累计字节有界；7个peer/broker/checkpoint测试，11组TS/Python shared fixtures。父端拒绝model/credential/routing覆盖；原生input/tool/provider hooks未移到宿主执行。
- `bash scripts/check.sh`通过84 JS files、524 passed/1 skipped、153 Python，typecheck/ruff/mypy/build、legacy/preset/protocol、107 runtime files、Pi 20文件patch、Flash 82文件/25函数及真实pack校验。随后新增checkpoint前缀回归，整个peer文件7/7及runtime-pi typecheck/lint再验。
- 加入该checkpoint回归后，最终再次执行`bash scripts/pnpmw run test`：84 files、525 passed/1 skipped；全部最新JS测试通过。
- 最初全套旧native文件测试触发5s timeout，单跑3.11s；限制Vitest并发8后仍复现一次，因此该多进程断言测试设为15s。产品超时/所有安全断言/覆盖范围均未放松。Python catalog固定清单补入新worker-frame后通过。
- Browser首跑6/6（21.8s），旧border/borderColor warning仍保留；pnpm frozen install与双uv lock通过；10 checkouts干净；PageIndex main复核仍ae169566；11文档/123本地链接通过。
- user DB、旧wire/schema和上游代码未迁/未改；目录仍未跟踪，未stage/commit。剩余正式pi.exec第二层、资源审批/不可变快照、完整controls/冷恢复/provider/后台/额度及R2–R7继续，见ADR-029/research25。

### 2026-09-08 · 持续目标第六批：整个文档协调器与单文件PDF隔离

- 前轮分类progress；本轮继续实际实现R1/R2文档边界，未缩减完整目标。Node coordinator已空根目录隔离；每个native PDF worker只读单文件，无cache/其他source目录；会话cache-only不再广告/接受ingest。
- 81 JS files、503 passed/1 skipped；Python 142 passed，ruff/mypy（22个source modules）/typecheck/build、legacy/preset/protocol/生成contracts、Pi 20文件patch全部通过。`bash scripts/check.sh`本轮完整通过。
- 新2个Node namespace测试+10个Python PDF isolation/validation测试；source/env/private/process/network/write/kernel syscall攻击探针，文本/PNG/正向bbox与原算法一致。现有Pi 10工具/六Read/图片/checkpoint和PDF matrix保持通过。
- 独立wheel重新构建/安装（不导入仓库源码），完成ingest、真实visual和Flash merge：6页5节点，wheelOnly/isolatedVisual=true。Flash main在线复核仍ae169566；共享seccomp guard纳入provider fingerprint，未改vendor算法或旧generation。
- bwrap实际版本0.4.0不支持--size；已改用只读tmp/dev+有界内存PNG，没有忽略失败或无界临时写目录。Runtime清单增4模块并拒绝未来漏列，当前107文件；原文/locator/wire/store schema未改，用户数据未迁。
- `test:browser`首跑6/6（20.2s）；既有border/borderColor warning仍记录，未改无关UI。10个pinned checkout干净可复现；12文档/117本地链接通过。没有stage/commit或变更sibling/upstream。
- 仅此文档Linux边界被验证；完整Pi/model/extension、聚合资源/跨平台、auth/Web/upload/selection/Answer/Research等目标继续。见ADR-028/research24，未开放任何新公网服务。

### 2026-09-08 · 持续目标第五批：Core文档应用与Pi数据链

- 本轮为progress：实际提取Library/Scope与Node文档基础设施，接通DocumentApplication、逐消息来源frame及Pi文档工具；非状态重述。完整目标active，未缩减R1–R7。
- 最终 `bash scripts/check.sh` 通过：80 JS files、501 passed/1 skipped；Python 132 passed；ruff/mypy/typecheck/build、legacy plugin/preset/protocol、Pi 20文件patch、generated contracts及packaged sidecar均通过。
- 7个新真实文档集成测试：Library导入→Pi 10工具结果（含六Read/Flash/原生Bash）→checkpoint，真实PNG hash；跨frame/跨会话/旧native session/foreign owner/policy/共享Investigation/改动hash与bytes。faux只用于模型，不冒充回答质量。
- 2个late-spawn lifecycle测试；新增document ownership gate。旧Library/supervisor等4文件29测试先通过，再跑全套。未改用户DB、wire/event/schema；全部工作在当前未跟踪产品目录，未git初始化/stage/commit。
- Flash main在线复核仍ae169566；10个pinned checkouts全干净。pnpm frozen install与两个uv lock checks通过；13文档/117本地链接检查。
- 修正plugin tar漏vendor JSON/License；新check实际pack验证81文件+provenance。当前pnpm isolated linker不支持bundledDependencies，尝试已撤回且未改linker；独立NPM部署策略仍R7，未把tar完整性当部署验收。
- `bash scripts/pnpmw run test:browser` 本批首跑6/6通过（21.0s）；既有border/borderColor warning未改。最终兼容patch再验通过。本批没有改Demo内容，未重跑test:demo，不把legacy browser回归当新Web已上线。
- 阻断公开上线的剩余项仍明确：完整ingest/read及Pi worker/model/native边界、auth/HTTP、上传/selection/Answer/Evidence、Record/Recall与真实Web/质量/重模块验收。详见research/23、ADR-027。

### 2026-09-08 · 持续目标第四批：Flash provider/generation/复用优化

- 本 goal turn 为 progress：从研究探针推进为内置opt-in provider、tree-index.v1合同、单worker与不可变发布、CLI/wheel；不是只重述计划。完整目标继续active。
- `bash scripts/check.sh` 最终通过：78 JS files / 491 passed / 1 skipped；132 Python passed，包含22共享tree合同样例和8实际provider/故障/65页用例；ruff/mypy/生成/构建/旧plugin/protocol/Pi patch全部通过。
- Flash pin重新在线核对仍为ae169566；`scripts/vendor_flash.py --check` 验证82文件/25原始optimizer函数；`bash scripts/verify_sources.sh` 验证10个source干净；root/packaged `uv lock --check` 通过。
- 新增固定 PyPDF2/regex/sortedcontainers。产物包括许可证/provenance；没有安装PageIndex chat/cloud/model闭包或改用户数据库/旧RPC。
- 实际三个PDF：完整merge与raw复用merge的所有树数据/统计相同；复用约1.4s，对比重解析4.2/9.2/6.2s，详见research/22。仅merge阶段，非召回/引用质量或整体ingest提速声明。
- 构建wheel后，`uv run --offline --isolated --no-project --python 3.12.12 --with ...whl python -I scripts/probe-flash-wheel.py` 最终通过：已安装包独立生成六页ready树。初次offline缺依赖缓存，允许依赖解析后再离线成功；无运行期模型/云PDF调用。
- 已实现namespace + seccomp拒fork/clone/exec/socket（native syscall验证）、CPU/RSS/时长/输出边界；不把该parser的局部安全证明推广为全Pi/产品安全证明。
- `bash scripts/pnpmw run test:browser`：首跑5/6，trace为React DOM脚本加载ERR_NETWORK_CHANGED/status -1；无产品改动、全部worker结束后重跑6/6。未证明网络变动根因，未放宽断言或加自动重试；既有border/borderColor warning仍在。本批未改Demo，未重跑test:demo。
- 最终独立wheel再次构建并离线隔离运行通过；最终sidecar 103文件与Pi兼容补丁复查通过；12份更新文档/110本地链接核对。
- 待续：R1剩余执行/认证/观察合同，R2/Pi tree reasoning/document准入与R3真实Web，Pi增强作业、legacy/full/多语言/OCR/真实长文质量、geometry、R4/R6/R7；完整范围未缩减。

### 2026-09-08 · 持续目标第三批：原生调度与 I/O

- 本 goal turn 为 progress：真实 Coordinator/heartbeat/queue/cancel、Pi 精确 user-message 关联、Linux 原生 I/O 与固定 SDK 补丁已改变 authoritative state；完整目标继续 active。
- `bash scripts/check.sh`：最终 77 JS test files / 469 passed / 1 skipped；102 Python passed；环境、lint/typecheck/build、contract/sidecar、plugin、compat/protocol、ruff/mypy 全通过。
- 新增 7 Linux backend tests、7 coordinator tests、1 lifecycle observer test；真实公开 SDK + faux provider，无付费/真实模型请求。
- `bash scripts/pnpmw run test:browser`：完整构建结束后运行，6 passed；既有 border/borderColor warning 未改。本批未改 Demo UI，未重跑独立 test:demo。
- `bash scripts/pnpmw install --frozen-lockfile --ignore-scripts`：7 包冻结安装通过；`bash scripts/pnpmw run check:compat` 验证 Pi 0.85.1、本地补丁与 20 个安装文件；`bash scripts/verify_sources.sh`：10 sources 全通过。
- Pi 原 checkout 未改，npm 安装由 pnpm patchedDependencies 适配；patch SHA b145c71509d1d6454fa20fc9d41b11bdbce4119bb76946cc3090e98e8508f905。详见 compat/pi/patches.md。
- 实测修复：/tmp 父 mount 遮挡临时 workspace；高层 SDK/grep/read probe/显式 Bash/输出目录的分散路径；重复文本关联、preflight ghost queue、未消费接受导致的悬挂。
- 原生 schemas/renderers/builtin origin/default工具保留；模型 loop/JSONL 不重写。Python lock、领域数据库、旧 DSH 字段未变。
- 仍需：官方 extension pi.exec / 可信资源快照 / worker-model-secret / 聚合资源-出口-后台任务、HTTP auth/observation/approval/native controls、文档准入/真 PDF Web、Flash provider 与 R4–R7 全体验/验收；未把局部安全测试当全部隔离证据。

### 2026-09-08 · 持续目标第二批：持久提交与 Flash 边界

- 本 goal turn 为 progress：新增 product-control v1、TS/Python bindings/fixtures、ControlStore、Pi checkpoint 与真实 crash 集成，正式 server HTTP 未部署；完整目标 active。
- ADR-024 仅接受已验证的内部控制合同；ADR-023 的完整 worker/auth/transport 保持 proposed。未改旧 DSH 字段、schema 版本或用户数据库。
- `bash scripts/check.sh`：最终 454 JS passed / 1 skipped、102 Python passed；全部 lint/typecheck/build/contracts/packaged sidecar/plugin/compat/protocol/ruff/mypy 通过。
- 新增 26 个 TS contract cases、同一套 26 Python cases（含 100 条状态组合检查）、12 个 ControlStore tests、3 个真实 Pi/crash/checkpoint integration tests；无真实模型网络调用。
- `bash scripts/pnpmw run test:browser`：首次与构建并行时 1 项因 navigation/context destroyed 失败，构建结束后单独重跑 6 passed；未关闭 axe、增加自动 retry 或修改被测组件。旧 border/borderColor warning 保留。
- 浏览器测试不再与同一工作区的 build/generation 并发运行，避免开发服务器重载干扰；上述失败的完整浏览器销毁原因未独立定性为产品 bug。
- `bash scripts/pnpmw install --frozen-lockfile --ignore-scripts`：7 workspace package 冻结安装通过；`bash scripts/verify_sources.sh`：10 sources 通过。
- `env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar --with sortedcontainers==2.4.0 --with PyPDF2==3.0.1 --with regex==2026.5.9 scripts/probe-flash-boundaries.py`：两次通过，hybrid/忽略书签 hash 一致；65页重复样本 empty。
- Flash 第二次 raw/bookmark/ignore/long 时间为 0.293/0.041/0.036/0.355s，peak RSS 82,324 KiB；不是质量/加速对照。原始记录见 research/20；provider 仍未接入。
- Python 项目依赖与 uv.lock 未变；product schema/binding 作为共享校验同步到 sidecar 包，不新增 Python 控制方法/凭据/loop。
- 下一工作包：真实调度/heartbeat、permission-aware prepare、HTTP auth/observations/approvals、完整 native/session/model boundary；Flash 固定 provider/generation/质量集继续推进。

### 2026-09-08 · 持续目标首批实现

- 本 goal turn 分类为 progress：公开 Pi 依赖、runtime composition/实验、Core 物理提取、PageIndex source pin 均已改变 authoritative state；完整目标保持 active。
- `bash scripts/pnpmw exec vitest run packages/runtime-pi/test`：10 passed（9 SDK lifecycle + 1 本机 namespace），无模型网络调用。
- `bash scripts/pnpmw --filter @docatlas/core typecheck` 与 `bash scripts/pnpmw exec vitest run packages/core/test`：通过，34 个 Core tests；原 tests 移动而非复制。
- 最终 `bash scripts/check.sh`：413 JS passed / 1 skipped、76 Python passed；全部环境/contract/sidecar/lint/typecheck/build/package/compat/protocol/ruff/mypy gates 通过。
- `bash scripts/pnpmw run test:browser`：旧 Web 6 passed，保留旧 border/borderColor warning。Demo UI 未改，本轮未重新运行独立 test:demo。
- `bash scripts/verify_sources.sh`：更新后的 10 个 sources 全通过；PageIndex main ae16956，JS SDK 9925e8a 未变。
- `bash scripts/pnpmw install --frozen-lockfile --ignore-scripts`：6 个 workspace package 的冻结安装通过；Pi 同族实际依赖均为 0.85.1。
- 生产代码新增初始 SDK composition；5 个领域实现迁移时 SHA 相同。旧数据、contracts JSON/Python lock、downstream 仓库、模型凭据均未修改。
- 本轮发现并修正：公开导出不同于 upstream test 内部导入、bwrap 不支持 clearenv 且设置 PWD、原测试 helper 首次 strict typecheck 的 narrowing 问题。
- 尚未完成：持久提交信箱/合同、完整 native/session/model 隔离、生产 server/Web、自有 PDF 真问答、Flash provider/质量对照与其余 R3–R7。详见 research/19，不把首问 crash gap 的复现写成修复。

### 2026-09-08 · 原型确认与后端设计

- 用户明确确认现版原型，D0-006/008 首轮 gate 完成；多文档/研究/个性化后续原型没有被批量标为 accepted。
- 新增 backend-delivery v1 与 ADR-023 proposed；主计划 v0.6、任务板、架构/迁移/原型/导航及 scaffold README 对齐。
- 重新阅读 Pi v0.85.1 SDK/session/session-manager/runtime factory/native tools，核对 DSH selection/compiler/store/supervisor 和 Python resolve/geometry；不是新 Pi runtime 测试。
- `bash scripts/pnpmw view @earendil-works/pi-coding-agent@0.85.1 version engines dist.integrity --json`：只读确认发布元数据。未 install、未调用模型。
- `bash scripts/check.sh`：401 JS passed / 1 skipped、76 Python passed；环境、contracts、sidecar、lint/typecheck/build、plugin/compat/protocol、ruff/format/mypy 全通过。
- `bash scripts/verify_sources.sh`：10 个固定 source checkout 全通过；未修改 .sources 或 downstream。
- 本轮只有设计文档更新，未修改运行代码、依赖/locks、生产 schema/数据库或部署；没有重新跑 browser tests，前轮 14 Demo / 6 legacy 结果仅保留为历史基线。
- 首个实现包明确为 R1-001a/004a 的公开 SDK、持久化与隔离实验，结果决定合同/实现；不把 proposed 安全方案写成已经成立。

### 2026-09-08 · Prototype 01 视觉收尾

- 用户已认可核心功能；本轮统一 paper/ink/blue 视觉 token、字号与留白，增加引用预览、可调分屏、可展开的一次性选区。
- 修复重复引用不重新定位、PDF 重排抢键盘焦点；短屏首页可滚动，320px 手机保留必要入口。
- `bash scripts/pnpmw run test:demo`：14 passed。新增 hover/focus/Esc/blur 预览、pointer/keyboard 分屏、草稿/焦点保持、选区回看、重复引用、320px/短屏；含 axe 与零外部浏览器请求检查。
- `bash scripts/pnpmw run test:browser`：旧 DSH 6 passed。旧 border/borderColor React warning 仍在，本轮未修改旧组件。
- `bash scripts/check.sh`：401 JS passed / 1 skipped、76 Python passed；environment/contracts/sidecar、lint/typecheck/build、plugin/compat/protocol、ruff/format/mypy 全通过。
- 单独运行 `bash scripts/pnpmw run lint` 与 `bash scripts/pnpmw --filter @docatlas/web-demo typecheck` 通过；生产构建由上述 browser/check 命令重新执行。
- 截图位于 `.cache/prototype-screenshots`（首屏/答案/原文/选区/抽屉/手机/预览/窄分屏）。本次图像工具无法显示截图，因此没有宣称已人工目检；浏览器交互/布局/对比度已验证，新版观感仍待用户确认。
- 未增加依赖、修改锁文件/生产 schema/领域数据，未修改 downstream DocAtlas 或研究 checkout。模型、Pi、个性化自动学习、持久化均未接入。
- 主计划更新至 v0.5，记录用户认可范围和下一阶段后端顺序；未把未来重模块或安全合同标成已完成。
- 已重启本轮持有的 4175 预览并保留原访问链接；实际服务再次浏览器验证首页、引用预览、PDF 高亮、分隔线，无 page errors。7 份更新文档的 33 个本地链接检查通过。

### 2026-09-08 · Prototype 01

- 新 apps/web workspace package，React 18.3.1 + PDF.js 6.3.289 + 本地 Noto Sans SC 5.3.0；pnpm-lock 同步，未改 Python lock/领域 schema。
- fixture 是现有 sample_report.pdf 的原始字节；构建从固定 base64 解码并校验 SHA-256，不依赖 ignored downstream checkout。
- 15 个新原型 unit tests 通过；首轮 browser 暴露移动端按钮名称/对比度问题，修复后 7 个主流程 browser tests 通过。
- bash scripts/pnpmw run test:demo：最终 9 passed，含真实鼠标选区、缩放重新定位、移动端/各 drawer axe、取消/迟到文件与零外部浏览器请求。已修复 PDF 滚动区键盘焦点和抽屉淡入造成的瞬时对比度问题。
- bash scripts/check.sh：401 JS tests passed / 1 skipped，76 Python tests passed；lint/typecheck、build、contracts、sidecar、plugin/compat/protocol、ruff/format/mypy 全通过。
- bash scripts/pnpmw run test:browser：旧 DSH 6 passed；保留其已有 border/borderColor React warning，本轮不修改旧 UI。
- bash scripts/pnpmw install --frozen-lockfile --ignore-scripts：通过；bash scripts/verify_sources.sh：10 个 pinned checkouts 全通过。
- PDF.js 按需加载；首屏 JS 约 177 kB（gzip 58 kB），Reader 分包约 439 kB，不含字库/worker。不是加载延迟 benchmark。
- 截图在 .cache/prototype-screenshots；人工视觉/用户评审仍待进行，不声称浏览器测试即视觉定稿。
- 原型运行未连接 Pi/DSH/Python 服务或真实模型；文件、笔记、偏好均留在浏览器当次页面状态。旧 DSH/sidecar 只由独立回归检查验证。

### 2026-09-08 · 源码与重组（R0 历史记录）

- 本地 Pi clone：v0.85.1，d981de1229ef899957bbe968bc8dcda02a21f477；未修改或安装 upstream。
- 已保存 DSH v0.2 主计划与旧任务板完整档案，正文仅重定位 Markdown 相对链接。
- 新增目录目前只有 ownership README，不宣称 adapter/server/Web 已实现。
- bash scripts/verify_sources.sh：10 个 source 的 origin/commit/detached/clean 均通过。
- bash scripts/check.sh：environment、generated contracts、packaged sidecar、lint/typecheck、build/package、DSH compat、protocol 全通过；386 JS tests passed / 1 skipped，76 Python tests passed；ruff/format/mypy 通过。
- 通过 scripts/pnpmw exec node 运行一次性文档/目录校验：33 份文档、144 个本地链接、3 个 anchor、5 个职责 scaffold 均通过。
- 两份档案与重组前读取的正文逐字核对（只允许归档说明、相对 Markdown 链接重定位及末尾换行差异），均通过。
- 前一轮 Flash 四 PDF 无模型 smoke 见 research/18；不是本轮新跑的质量 benchmark。
- 未运行 Pi 原生/真实模型/browser 产品验收；相关工作仍 queued。
- 本轮未改业务代码、package manifests/依赖锁或数据库，也未移动 DocAtlas-Harness 独立仓库；未 git init/stage/commit。

## 完成检查

每个包记录：来源与目标、代码/数据/产品状态、测试命令与结果、未覆盖场景、协议/权限/迁移影响。
不把 inherited、scaffolded、source-reviewed、implemented、integrated、user-accepted 合并成一个 done。
