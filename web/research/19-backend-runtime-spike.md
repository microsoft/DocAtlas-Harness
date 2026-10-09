# 后端首批实现：Pi 运行实验、Core 提取与 Flash 更新

> 2026-09-08 · 首个持续目标推进记录。
> 不是完整后端验收：产品合同、持久提交信箱、正式隔离 runtime、模型服务、Web 集成与 Flash provider 仍未完成。

## Pi：从源码判断到公开 SDK 执行

`packages/runtime-pi` 已成为可构建 workspace package，精确安装 `@earendil-works/pi-coding-agent@0.85.1`
与 `@earendil-works/pi-ai@0.85.1`，通过 pnpm 11.7.0/Node 22.19.0 安装并同步 lock，未执行 upstream npm build。
实际依赖图中的 pi-agent-core/pi-tui/pi-telemetry/chord 也为 0.85.1。

新增 `createPiRuntime` 使用公开 SDK 创建完整 AgentSessionRuntime，并在 new/resume 时重新绑定扩展/观察。
调用方必须提供 ModelRuntime；不隐式打开默认凭据库，不限制为文档工具，不复制 loop。
这是内部组合模块，不是对浏览器开放的运行入口，也不是已实现的 sandbox/产品身份合同。

公开入口实测纠正了照搬 upstream tests 的风险：根包未导出其测试中直接使用的 AuthStorage；
pi-ai 根入口提供 fauxProvider 而非旧式 registerFauxProvider。现在使用公开 InMemoryCredentialStore /
InMemoryModelsStore 与 registerNativeProvider，测试不读写真实模型凭据、不依赖网络。

9 个 lifecycle tests 已执行：

- 原生 read/bash/edit/write 与可选工具清单保留，trusted AGENTS/skill 被加载，增量 docatlas_probe 不覆盖原生工具。
- 真正运行文件 write/edit/read 与 Bash，检查真实文件和 tool results，不只检查工具名。
- 同步 message_end 观察时首问文件尚未写出；真正 settled 后 Pi 原生 JSONL 可恢复原 session/leaf。
- new/resume 重新绑定实例与观察，旧会话可继续；不是重用已销毁的对象。
- 原生工具错误保留 isError，steer 的后续问题实际进入模型上下文。
- 显式 Bash 有独立取消路径；另一个测试启动真实 shell/tail，abortBash 后检查目标 PID 已退出。
- 在真正的子进程首次模型调用前发送就绪信号，SIGKILL 后验证首问仍未形成 JSONL：首问 crash gap 已复现，尚未修复。

这些证明局部 SDK 行为与风险，不证明真实 Azure、完整 parity、强持久性或产品恢复已经完成。

## Linux namespace 探针

`namespace-isolation.spec.ts` 在临时工作区中执行 pinned Node：项目 RW、来源 RO、产品私有 canary 不挂载，
隔离 PID/network，并仅传白名单环境。实际验证工作区可读写、来源不可修改、宿主 home/私有文件不可见、宿主监听端口不可访问。

环境现有 bwrap 不支持 `--clearenv`；使用 spawn 的显式 env，bwrap 另外设置 PWD。测试检查只存在 PATH/PWD，
没有把工具环境转存日志。非 Linux/无 bwrap 的 CI 会显式 skip 此能力实验，不能据此认定产品安全 gate 通过。

这一项只证明本机 OS 原语可用。Pi 自身的 transcript 写入与 native 文件权限如何分离、完整 provider/模型 broker
与任意可信扩展的访问边界仍在 R1-004a；没有对外开放未隔离的 native tools。

## Core 提取

5 个实现从 plugin 移入 `packages/core/src/storage`，共 9,465 行，移动时逐文件 SHA-256 相同：

| 模块 | 提取时 SHA-256 |
|---|---|
| source-scope-store | 226f0d43ebdf8d26fd65a1c746caec2818fb203088cb5b8291c676b49fa8a2ae |
| investigation-m4-store | 36a926eecacc95c21631a965cb5ab505f23b85824341ee607a3d0f56e7011edc |
| investigation-continuity-store | 91d6f30bf8e1e8916434e5a9824868025c01978963a42b256bd379f0cedaf98d |
| continuity-service | e9769819cf87dcb62e835390090ddbbe7373d166baad68fbacc2ef01795f9a9b |
| personalization-store | 927b05675e62ffd48aacc5151930db32f0ca75520a4b6d5f767b404f6d195772 |

旧路径只保留两行兼容 re-export；不是两份实现。对应 5 个纯模块测试也移到 Core，现有 plugin integration tests
继续通过旧入口覆盖新 Core。新增依赖方向/非重复实现检查。
移动后的测试首次纳入严格 typecheck，修正两处原有 test-helper 联合类型/闭包 narrowing，未改变领域算法。
数据库 schema/ID、用户 DB/blob、DSH history、profile 与 downstream 子仓库均未移动或修改。

## PageIndex 更新

按用户明确要求，将 `.sources/pageindex` 与 source lock 从 `9fee239` 更新至本轮核对的 main `ae16956`，
保留 clean detached checkout。JS SDK 最新 main 仍为 `9925e8a`，无需无意义改 pin。

`git diff old new -- pageindex/flash` 为空：本次不是 Flash 构树算法更新。
更新包括 ChatStream 单次 run 的 events/text 视图、部分消费/中途错误处理、MCP 多模态 content 保留、
过程显示省略图片 base64、协议与调用配置整理、Flash notebook。详见 research/18 的采用矩阵。
不移植其 chat loop，不调用 Cloud，不因过程事件变丰富而向模型/浏览器倾倒大结果。

下一项仍需真正实现：有资源限制的 raw/merge provider、独立 index generation、书签融合/噪声过滤能力测例、
长 PDF worker 控制、质量对照，以及显式 runtime 托管的可选增强；不能拿本次 pin 更新当 Flash 已接入。
