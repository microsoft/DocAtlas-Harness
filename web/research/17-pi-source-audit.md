# Pi 本地源码审计：从执行引擎到 DocAtlas 产品

> 调研日期：2026-09-08
> 本地 checkout：`.sources/pi`，官方 `https://github.com/earendil-works/pi.git`
> Release：v0.85.1；commit：`d981de1229ef899957bbe968bc8dcda02a21f477`；detached HEAD。
> 这是源码分析，不是 Pi 集成测试或全仓安全审计。未安装/构建 Pi upstream，也没有修改其源码。

## 1. 阅读路径

审阅 SDK factory、cwd-bound services、runtime replacement、core Agent/loop 和 AgentSession 的执行控制；
结合 SessionManager 持久化路径、resource loader 接口、extension 文档和 package exports 定位接入风险。

| 本地源文件（相对 `.sources/pi/`） | 确认的事实 | 对 DocAtlas 的影响 |
|---|---|---|
| `packages/coding-agent/src/core/sdk.ts` | 默认工具 read/bash/edit/write；customTools 是增量；默认加载资源；通过 ModelRuntime 构造完整 AgentSession | 不使用 `noTools` 或文档独占 allowlist；不是只取 pi-ai |
| `packages/coding-agent/src/core/agent-session-services.ts` | services 与 session 分开；加载扩展 provider、收集 diagnostics；允许 caller 注入 modelRuntime | 产品负责身份/生命周期；错误不能隐藏；provider 注册不能漏 |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | new/switch/fork/import 会重建 services/session；旧 session dispose 后才创建新实例 | rebind events/UI/context；失败可使旧实例失效；native controls 需完整接线 |
| `packages/agent/src/agent.ts` | core listener promises 被等待；active run 与 abort/idle；默认 parallel | 不将 browser I/O 放进 awaited critical path；提供单 writer 和 backpressure |
| `packages/agent/src/agent-loop.ts` | 参数验证、truncated tool-call 拒绝、顺序 preflight/并行 execute、结果按原调用顺序入消息；steering 在 batch 后 | 不能删这些 safety/performance 行为；event 完成序不等于 transcript 序 |
| `packages/coding-agent/src/core/agent-session.ts` | 统一 prompt/resources、hook、重试、压缩、队列、native Bash、分支与 extension UI | 产品不得用薄 send/stop API 裁掉完整 session 能力 |
| `packages/coding-agent/src/core/session-manager.ts` | 原生 JSONL tree；新会话可能到首个 assistant 才落盘；append 与 domain transaction 无统一事务 | 首问 crash-safe acceptance 是真实 gap，需单列 gate |
| `packages/coding-agent/src/core/resource-loader.ts` | 内置资源与 inline factories、append prompt、trust/reload 接口 | 可以保留原生能力并注入 Core bridge，不必替换整个 prompt/loader |
| `packages/coding-agent/package.json` / `packages/server/README.md` | experimental/source-only surfaces 与正式 package root 分开；server transport 不实现完整 peer auth | 首发不用 experimental server/client；源码存在不等于可发布依赖 |

## 2. 重要时序不是接口名字能说明的

### 2.1 Low-level end 不等于产品结束

AgentSession 的 `_runAgentPrompt` 在 `agent.prompt` 后还运行 `_handlePostAgentRun`，可能 retry、compact 或继续
队列。最后才 `_emitAgentSettled`。因此把 `agent_end` 映射为 Web “完成”会出现结束后又开始、按钮状态错误。

### 2.2 Listener 不是 durable commit hook

AgentSession `_handleAgentEvent` 先 dispatch extensions、notify session listeners，再调用
`sessionManager.appendMessage`。`AgentSessionEventListener` 返回 void；它不同于底层 Agent 等待 Promise 的
listener。因此 `subscribe(async ...)` 不提供业务事务屏障。`turn_end` 时前面的消息已 append，但不意味着
经过 fsync 或 Core journal 已提交。产品 needs explicit checkpoints/commit semantics。

### 2.3 接收和持久化必须分开

`prompt` 的 `preflightResult(true)` 可能代表命令处理/队列接受；SessionManager `_persist` 在新会话尚无
assistant 且未 flushed 时不会创建文件。不能把一个成功 callback 当成可从机器故障恢复的用户提交。
也不能插入伪造 assistant 消息强行触发持久化。具体解决方案在 R1 通过 fault-injection 比较后冻结。

### 2.4 Cancel 有多条路径

`abort()` 停 retry/compaction/branch-summary/agent；显式 `executeBash` 有自己的 `_bashAbortControllers` 和
`abortBash()`。Python、原生 user Bash、子任务及人机对话框需要产品协调取消。领域写入发生后取消不等于回滚。

### 2.5 Hook 不能随意覆盖

AgentSession `_installAgentToolHooks` 安装的 before/after 连接 extension runner，并规范化工具图像。
`_installAgentNextTurnRefresh` 还处理下一轮压缩、model、system prompt 和 tools。重写这些字段可能切断原生
能力。优先经受支持的桥接点接入 Core，必要改动有 parity test，而非直接 monkey patch。

### 2.6 Runtime replacement 改变对象身份

`teardownCurrent` abort/dispose 后再 create；`setRebindSession` 提供绑定机会。工作区/cwd/trust/provider 都可能
变化。Web 的延迟回调必须带 runtime generation，旧句柄不能操作新会话。恢复或 fork 不是简单替换 sessionId。

## 3. 维护设计

1. `packages/runtime-pi` 是唯一 Pi 依赖边界；Core 不 import SDK 或 upstream 内部源码。
2. 优先正式 package root 的 public SDK；来源固定 release，应用依赖另行锁定。
3. 保留 native tools/resources 和完整 session API；UI 可简洁，功能不能被 CSS 或 allowlist 悄悄删掉。
4. custom TUI components 需要额外 Web adapter；兼容分级公开，不宣称自动全兼容。
5. Pi 的 MCP、子 Agent、plan 等是扩展方向，不是全都内置；不能将“支持扩展”写成“已经完成”。
6. native Bash 使 document-tool allowlist 不再构成安全边界；实际 mount/process/secret policy 必须覆盖所有工具。
7. 不跟进 main 的实验性 server 协议；先解决少量明确的产品边界，不再重建一个大宿主平台。

## 4. 对现有 DocAtlas 资产的判断

`source-scope-store`、M4/Continuity/Personalization stores 主要依赖 Node/contract，可优先提取。
`library-service`、`selection-service` 仍引用 `DocAtlasRuntime`/DSH message，需拆 ports。
`index.ts` 是 Cordis composition，不是新 Core 的合适起点；`EvidenceDeskView.tsx` 混合 DSH chat/input snapshots
和 reader 行为，应拆状态/呈现。现有 CSS hiding 只留在 legacy。

真正的新工作是把领域主权和运行协调迁到产品；不是重新实现已有 Claim/Memory，也不是把全部旧代码改名为
`pi-extension`。结论进入 [ADR-021](../docs/adr/021-docatlas-first-pi-runtime.md) 与 [迁移表](../docs/migration/dsh-to-core.md)。

## 5. 验证范围

本轮拉取固定源码并运行 workspace/source 检查；没有执行 Pi 原生回归或真实模型请求。
新的 parity、first-prompt durability、rebind、cancel、UI prompt 和 mixed-task 场景均在任务板上标 queued。
旧 DSH 测试通过只能证明旧基线未被本轮目录/文档整理破坏。
