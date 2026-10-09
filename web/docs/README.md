# DocAtlas 文档导航

从 [实施主计划](implementation-plan.md) 和 [执行任务板](execution-tracker.md) 开始。

用户已确认 [Prototype 01](product/prototype-01.md)，当前进入后端设计/实现队列。先读
[后端详细设计](architecture/backend-delivery.md)：模块、接口、存储/恢复、安全、现有资产复用与首个实现包。

- [架构决策 ADR-021](adr/021-docatlas-first-pi-runtime.md)：DocAtlas 是核心产品，Pi 是完整执行引擎。
- [Core 边界](architecture/docatlas-core.md)：领域主权、依赖方向、三种树与混合任务。
- [Pi 接入](architecture/pi-runtime.md)：能力保留、持久化/事件/取消/会话切换风险。
- [ADR-023 提案](adr/023-product-backend-control-plane.md)：后端工程候选、必须验证的 seam 与合同冻结门槛。
- [ADR-024](adr/024-durable-product-submissions.md)：已验证的内部持久提交/运行控制契约，实际 Pi 存档与 crash 恢复边界。
- [ADR-025](adr/025-native-io-and-submission-dispatch.md)：原生 I/O 与调度的兼容补丁、运行验证和仍未关闭的执行边界。
- [ADR-026](adr/026-flash-provider-generations.md)：可选 Flash provider、不可变版本、单 worker 边界和 raw→merge 复用。
- [ADR-027](adr/027-document-application-and-pi-tools.md)：Core文档应用、独立Node进程适配、Pi工具与逐消息来源权限。
- [ADR-028](adr/028-document-process-isolation.md)：Node协调进程与单文件PDF worker双层隔离，算法等价与安全探针。
- [ADR-029](adr/029-pi-worker-and-model-broker.md)：独立Pi worker、宿主model/native/document代理与方向性IPC。
- [ADR-030](adr/030-extension-execution-and-resource-snapshots.md)：pi.exec隔离、按内容审批资源、只读快照与启动早期取消。
- [ADR-031](adr/031-shared-namespace-lifecycle.md) / [ADR-032](adr/032-local-authenticated-http.md)：统一namespace生命周期与配对认证HTTP命令边界。
- [ADR-033](adr/033-conversation-observations.md)：有界SSE、会话快照、重连resync与checkpoint文本投影。
- [ADR-034](adr/034-live-chat-client.md)：独立真实聊天页、静态浏览器合同校验、持久回执与标签页重试草稿。
- [ADR-035](adr/035-managed-session-reopen.md)：运行时归属目录、新建会话、原生文件封存与正常关闭后的精确恢复。
- [ADR-036](adr/036-live-document-admission.md)：真实 PDF 上传、Library 准入、问题来源绑定与同版原件阅读。
- [ADR-037](adr/037-product-selection-tickets.md)：原文选区核验、持久一次性票据与整组消费绑定。
- [ADR-038](adr/038-flash-enrichment-jobs.md)：显式 Flash 摘要/展开作业、预算/独立 overlay 与 Pi 只读导航。
- [ADR-039](adr/039-checkpoint-backed-answer-citations.md)：宿主Read凭据、Pi checkpoint回答与同版原始PDF引用。
- [ADR-040](adr/040-local-product-launcher.md) / [本机Web指南](product/local-web-beta.md)：真实loopback产品入口、Azure模型和运行边界。
- [ADR-041](adr/041-product-research-and-capture-scopes.md)：Pi Record/Recall、capture scope、私有执行归属与真实Notebook。
- [ADR-042](adr/042-explicit-product-personalization-controls.md)：独立偏好控制、身份/CAS/隐私边界与尚未接入的模型应用。
- [ADR-043](adr/043-ephemeral-personalization-application.md)：请求级表达指导、真实生成使用记录、撤销与 v1/v2 兼容；不把指导写进原生消息。
- [ADR-044](adr/044-portable-human-claim-review.md)：人类 Claim/Review 的可移植 Core 应用与原领域边界。
- [ADR-045](adr/045-local-human-review-workbench.md)：已接的本地人类结论/审阅工作面、原Evidence授权、整请求幂等与独立签署/本地成果；不等于完整R4或对外发布。
- [ADR-046](adr/046-explicit-revisions-and-continuity.md)：显式同文档版本/CAS、历史原始PDF、旧研究完整依赖与双侧重新读取后的人工Continuity；保留版本固定、原权限和恢复边界。
- [ADR-047](adr/047-controlled-presentation-learning.md)：同一真实Answer的确定性单变量呈现、原子选择/候选/回执、独立确认、贡献/使用分离与隐私导出；不代表自动学习及纵向效果验收。
- [ADR-048](adr/048-native-operations-and-history-pages.md)：首问前原生设置、intent/commit证明、统一stop/未决屏障、无执行的冷对账与原生历史分页；配置不是问题，prepared文本不是用户原话。
- [ADR-049](adr/049-manual-native-compaction.md)：手动Pi上下文压缩、真实原生记录/可证未应用、原键恢复与历史PDF引用；摘要不是Evidence或个人记忆。
- [ADR-050](adr/050-native-lineage-handoffs.md)：真实selected-head/navigation/fork、原生证明/实际join与代际交接、历史原Answer/PDF归属；不复制事实或伪造问题checkpoint。
- [ADR-051](adr/051-flash-numbered-heading-guards.md)：有限编号标题修复、exact-hash vendor/上游与本地patch provenance、同PDF配对和反例。
- [ADR-052](adr/052-human-research-authoring.md)：独立人类笔记/问题/决策/规则、原PDF选区直接保存、完整版本编辑与只读标记；同journal/原子回执、v5→v6先备份，研究不冒充Evidence或个性化。
- [ADR-053](adr/053-bounded-parallel-flash-enrichment.md)：显式v2 Flash双路frontier/DAG、整job预算预留、确定性输出和全部真实调用收尾；旧任务保留v1。
- [ADR-054](adr/054-consented-preference-learning.md)：独立同意的低频邀请、跨独立研究的明确选择积累、不可变候选/原键回执和独立确认；集成验收见任务板，不把规则阈值当效用证明。
- [Flash生成PDF质量gate](../evals/flash-quality/README.md)：中文/长PDF的真实ingest/tree/Search/locate/bbox对照、中文子串与重复模板空树修复；完整真实语料/OCR质量仍待。
- [PageIndex/SDK跟进](../research/38-pageindex-sdk-followup.md)：发布版本与源码区别、SDK scope边界、benchmark限制和待评审的有界并行增强。
- [Web 产品规格](product/web-experience.md)：chat-first、原始 PDF、选区、多文档、重模块和通用任务。
- [Prototype 01](product/prototype-01.md)：当前真实/模拟边界、体验路径、运行方法与后续原型轮次。
- [迁移清单](migration/dsh-to-core.md)：现有模块逐项去向与 code/data/product gates。
- [环境](environment.md)：固定工具版本；已安装 Pi SDK 不等于已部署完整产品。
- [历史 DSH 档案](archive/dsh/README.md)：完整旧计划/任务板，不是当前执行状态。
- [研究索引](../research/README.md)：此前讨论及最新源码证据，均保留。

文档优先级：当前用户决定 → accepted ADR → living plan → product/architecture specs → research。
实际“能否运行/已完成什么”以任务板的验证记录为准，不以架构图或目录存在为准。
