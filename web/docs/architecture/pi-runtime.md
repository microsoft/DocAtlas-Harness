# Pi runtime 接入设计与能力保留

> Source baseline: Pi v0.85.1 / `d981de1229ef899957bbe968bc8dcda02a21f477`。
> 状态：公开 SDK 已安装，初始 runtime composition 与 9 个 lifecycle tests 可运行；完整产品 adapter/安全/parity gate 未完成。
> 后续实现：固定SDK兼容补丁、原生I/O配置、精确user-message关联、queue/heartbeat/cancel协调已验证；见 ADR-025 / research/21。未认证为完整生产安全边界。
> 详细依据：[本地源码审计](../../research/17-pi-source-audit.md)。
> 最新有界接入：[ADR-048](../adr/048-native-operations-and-history-pages.md)提供首问前model/thinking/双queue持久化、Web控制和历史分页；[ADR-049](../adr/049-manual-native-compaction.md)接手动compact；[ADR-050](../adr/050-native-lineage-handoffs.md)接实际selected-head/navigation/fork、原键分阶段交接与历史原证据，不新增SDK补丁。冷未决不运行factory；准确SDK/host/Web验收见任务板第二十二至二十四批。自动in-turn压缩/steer、完整扩展UI与parity仍待。
> 原型已获确认；当前工程拆解与下一实现包见 [后端详细设计](backend-delivery.md)，合同仍在 ADR-023 提案阶段。

## 1. 采用完整 SDK，不重写原生 loop

`apps/server` 创建 DocAtlas application、workspace 与 investigation，再通过 `packages/runtime-pi` 构造
`createAgentSessionServices` / `createAgentSessionFromServices` / `AgentSessionRuntime`。保留原生默认工具及
用户显式配置的 tools/Skills/extensions/AGENTS/models。DocAtlas 内部 bridge 只把 Core 命令、context 和 UI
交互接入受支持的 SDK/hooks，不把 domain persistence 变成 extension-local state。

不要直接覆盖 `agent.beforeToolCall/afterToolCall`：AgentSession 安装的 hooks 还承担原生扩展调用和图像规范化。
使用受支持的 extension/tool seams，并对顺序及故障策略测试。DocAtlas runtime 不是 `noTools='builtin'` profile。

## 2. Native parity 验收矩阵

| 能力 | 产品要求 | 验收要点 |
|---|---|---|
| read/bash/edit/write，grep/find/ls 等原有可选工具 | 保留原生语义/配置，不用 DocAtlas tools 覆盖 | 基础文件任务、diff、截断、错误、取消、mutation queue |
| Skills/AGENTS/模板/扩展/自定义 provider | 保留 trusted discovery、reload 和按项目配置 | 跨 cwd 切换、拒绝未信任代码、错误提示、同名冲突 |
| 模型与 reasoning/image | 保留可配置能力 | session-only vs persisted 设置、图片边界、Azure token refresh |
| Session / fork / branch / import / export | 保留原生 transcript format 和操作能力 | first-response crash、冷恢复、单 writer、branch/调查关联 |
| stream / retry / compaction | 保留原生流程 | transient vs committed、auto-retry、overflow、partial/cancel |
| steer / follow-up / queue | 不降级为只有 send/stop | 接收/排队/真正生效分别展示；选区不会附错 queued message |
| 扩展对话框与命令 | Web 提供 select/confirm/input/editor 等映射 | request ID、deadline、disconnect、cancel、重复响应 |
| 自定义 TUI 组件/快捷键/theme | 继续可在 native TUI 使用；Web 必须声明适配等级 | 不把 no-op 称为兼容；terminal-only 扩展有明确提示 |
| 子 Agent、计划、MCP 等扩展能力 | 保留扩展点，逐项批准实现 | 不是 Pi 开箱内置承诺；scope/budget/lineage/cancel |

实现 parity 的含义是“功能和行为不被 DocAtlas 意外删减”，不是无条件执行任意服务器操作，也不是自动兼容
所有第三方终端组件。通用任务不被强制要求 document scope 或引用。

## 3. 运行与事件边界

以下是待 R1 contract review 固化的产品概念，不是已经新增的 wire event：

```text
submission: draft → preparing → admitted / rejected → bound-to-run
run:        queued → running / waiting-for-user / retrying / compacting
                 → cancelling → settled / failed / outcome-unknown
event:      live observation → transcript/domain checkpoint → recoverable projection
```

必须同时处理：

1. `preflightResult(true)` 可能仅表示 extension command 已处理或消息已排队，不能当成模型执行完毕/持久成功。
2. 核心 `agent_end` 后 AgentSession 仍可能 retry/compact/continue；UI 收尾依据 session settlement 与自有待提交事务。
3. `Agent.subscribe` 等待异步 listener；`AgentSession.subscribe` 是同步通知，不是异步持久化事务 hook。
4. `AgentSession` 先通知 message_end listeners，再 append 到 SessionManager；并行工具的完成顺序也不同于
   transcript 顺序。不能在任意 callback 里先标“durably committed”。
5. stock SessionManager 新会话可能等首次 assistant 才创建 transcript 文件。R1 必须用 fault injection 选择
   reviewed native persistence adapter 或有明确去重/retention 的 submission recovery；不能伪造 assistant 消息。
6. sidecar command 的 idempotency 绑定 product run + runtime session/branch + tool call，不只用重置的 turnIndex。
7. 慢浏览器不能阻塞 model/tool loop。接入 bounded queue、snapshot/checkpoint、sequence/generation 和重新授权；
   断线不自动重发带副作用的工具。服务重启后的 unknown outcome 先查询/对账。

## 4. 所有提交入口统一准备

Landing、resident composer、PDF selection、重试、恢复后的发送、steer/follow-up 都进入同一个 product admission
service：认证 → 解析 opaque refs → 文档准备/版本核验 → SourceScope CAS → selection all-or-none claim → Pi 提交。
浏览器只是发起 intent；不能只有首屏执行 `@PDF` preflight。普通代码文件引用仍沿用 Pi 文件能力，不强制转为 PDF。

运行中新增 source 不应偷偷改正在执行工具的快照：当前 batch 保持已绑定 scope，变更在明确的下一步边界生效。
无法做到安全跨步 admission 时保留草稿/排队并提示原因，不让模型循环要求用户“手动绑定 Source Scope”。

## 5. 会话切换与取消

`AgentSessionRuntime` 的 new/switch/fork/import 会 dispose 旧实例并重建 cwd-bound services；必须重新订阅、
bindExtensions、重建受权 Core binding，清理旧 selection/approval handles。旧 generation 的延迟事件不能更新新会话。
替换失败时旧实例可能已被销毁，UI 必须明确 recovery 状态，不继续对失效实例发送请求。

取消覆盖：Pi model/tool loop、retry、compaction、branch summary、显式 user Bash (`abortBash`)、Python worker、
受管 child/index jobs、pending UI prompts。请求 abort 不等于已停止；有可能已提交的领域写入不自动回滚。

Pi session tree 与共享研究 journal 分开：branch navigation 不抹掉历史研究成果。跨 native TUI/Web 使用同一
会话需要单 writer/handoff，不能让两个独立 SDK 实例同时改同一 transcript。

ADR-050区分完整文件seal与真实SDK selected head：导航不是把文件tail当新上下文，也不伪造提问checkpoint。
同会话navigation保留SID并更新binding/generation；fork保留父会话，以SDK真实child文件、新CID/SID和独立writer交接。
只有实际effects/namespace join、精确文件安装与Control/Catalog提交完成后才可继续。冷原键恢复只能补完已经证明的交接，不重跑SDK或猜测接管活跃claim。
旧Answer/Read/Evidence保持原manifest、scope和publication，通过原conversation/source权限访问；继承聊天不是新Read准入。
已拥有的native聊天记录与source读取权限分开，撤销文档不声称擦除历史原话；结构化引用与原件必须另行重新授权。

## 6. 安全与部署

第一版 local/private，所有浏览器 route、SSE/WS 和 PDF asset 都先认证和 workspace/source 授权；具体 transport
契约在 R1 评审。保留 shell 需要实际 process/mount/credential 边界，单纯 DocAtlas tool hook 不是沙箱。
Pi project trust 是资源信任，不等价于多用户 ACL。UI shell 操作、extension code、provider credentials 的权限分开。

所有模型操作通过同一 runtime auth/routing/usage policy。Azure Entra token 只在内存中短期使用，不传给浏览器、
Python sidecar 或通用 shell 环境。Flash raw 不需凭据；摘要/优化是显式可取消的模型作业。

ADR-043补充：个人表达指导在host broker的每次已授权请求中临时追加，不写Pi消息/历史，不裁native tools或approved
payload hooks。真实生成正文后才记使用，撤销中止并禁止同submission隐藏替代重试；terminal progress等实际provider result
join后交给Pi。模型遵从/真实事实质量需要另行评测，个人偏好不得成为Evidence。

[ADR-045](../adr/045-local-human-review-workbench.md)的人类Claim/Review工作面运行在产品host/Core，而非Pi新增签署工具。
用户选择历史审阅快照不更新native active scope、不重新提交问题/消费选区，也不写第二份聊天历史。Answer证据只在原Read
与同一completed Pi checkpoint/publication的授权链通过后可用于人类成果；原文位置真实不等于结论的语义正确。
独立材料核对、G0–G4、人工签署/本地Publish不授予模型人类身份；本批不缩减Pi工具，也不宣称完整native parity或混合算术执行已经验收。

## 7. 升级策略与未决项

- `.sources/pi` 固定 release；npm 依赖接入时再用相同版本锁定。上游 main 的新接口不自动成为 release 能力。
- 不采用 source-only experimental client/plugin 或新 Pi server 协议作为首发依赖。
- 每次升级先读 SDK/session/resource/loop/tools 差异，再跑 parity、durability、Web、文档与 Memory regression。
- R1 仍需决定 durable acceptance、browser event replay/DTO、actor/run identity、权限执行边界和 extension Web UI contract。
- SDK seam 若不足，先记录具体失败和最小 patch/上游贡献方案；不直接全面 fork。

## 8. 后端开工前补充核对（2026-09-08）

- 公开 npm 元数据确认 v0.85.1 与 Node >=22.19.0 声明；未安装或执行 SDK，不能作为 parity 证据。
- 高层 createAgentSession 未透传统一 native Operations 配置；低层公开 AgentSessionConfig.baseToolsOverride 与
  runtime factory 可作候选，但 minimal ToolDefinition 重建、设置/资源 reload/显式 Bash 必须对照测试。
- Selection 的内存 stage/DSH UserMessage、Answer compiler 的 DSH turn/call catalog 不能直接作为新产品协议。
- R1-001a/004a 优先验证持久提交信箱、native transcript checkpoint 与实际 session/native/model 隔离；
  工程候选和失败回退边界见 backend-delivery §7–8。尚未选择/部署 sandbox 或 secret bridge。

随后实施更新：`packages/runtime-pi/src/create-runtime.ts` 已使用公开 SDK 组合完整 runtime、按新/恢复会话 rebind。
9 个 lifecycle tests 实测 native 文件/Bash/工具/资源、steer、错误、取消/真实 PID、会话恢复及首问 crash gap；
1 个 namespace test 实测 OS 原语。缺口已复现，持久信箱与完整 native/session/model 隔离仍未完成，见 research/19。
