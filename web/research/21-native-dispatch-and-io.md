# 原生调度与 I/O 实现记录

> 2026-09-08 · 持续目标第三批；目标仍 active。
> 不是正式 Web/安全/全能力验收。实现与剩余边界见 ADR-025。

## 从手动串测试到运行协调

`SubmissionCoordinator` 现在真正连接 control inbox 与 PiProductDriver：按持久输入准备、记录 dispatch intent，
再交给原生 Pi。普通消息排队；steer/follow-up 保留 Pi 队列优先级。租约心跳持续更新；失去 writer 后先停止真实
执行，再恢复为 unknown。取消等待 preparation/native runtime/backend，而不是只翻 UI 状态。

PiProductDriver 通过新的 onUserMessage 兼容入口关联精确的已转换 user object，再绑定实际存入 Pi 的 user entry。
两次相同问题与不同队列不再靠文本/时间戳猜关联；完整 transcript 格式不改。保存成功仍取真实 native checkpoint。
SDK 接收却没有消费 user entry 的故障会清理队列、停止、保留输入并标 unknown，不永久挂起或自动重放。

7 个 coordinator tests 使用真实公开 SDK + faux provider：普通发送/重复键、相同文本的 queue 优先级、慢轮次心跳、
当前/排队取消及再次发送、迟到 preparation/未实现文档准入拒绝、writer 丢失、SDK 接收但未消费的故障注入。
最后一项明确是边界 fault injection，不冒充上游已自然复现的缺陷。

## 原生工具接入

高层 SDK 原本无法透传 ToolsOptions；grep、read path-variant probe、显式 Bash、输出文件还有各自的宿主路径。
以固定版本 patch 补入口，保留原生定义/metadata/renderers/schema/defaults/loop。没有把原生工具替换为同名 DocAtlas 工具。
MIME 探测复用原函数，保留 APNG/JPEG/BMP 校验；不是只按几个 magic bytes 放行。

LinuxExecutor 使用真实 user/PID/network namespace：workspace RW，source/output RO，私有状态不挂载，环境白名单。
临时文件在本 runtime 的 scratch 中跨调用保留；native output 文件可回读而不可由 native write 改写。
资源限制目前是每次操作时长、输入/输出/读取大小、活动 launch 数；不是已经具备 aggregate cgroup quotas。

7 个 Linux tests 验证真实文件、私有/symlink/RO 拒绝、7 类原生工具、metadata/builtin origin、显式 Bash、长输出回读、
进程取消/超时/输出上限、实际宿主监听端口拒绝，以及 coordinator→真实 Bash 启动→取消→再次写文件→native checkpoint。
启动成功由真实工作区 flag 文件证明，不只凭进程对象或 tool-start callback。

测试发现的实际修正：scratch 的 /tmp mount 必须先于嵌套 workspace/source mount，否则会遮住临时工作区；
未通过预检时没有降级宿主执行。默认 SDK 生命周期测试仍通过；新增 transformed message/ghost queue rejection 测试。

## 明确保留的后续工作

- 官方 extension pi.exec 仍有宿主 exec 路径；直接 Node 扩展代码属于可信 TCB，不能称为已被 native op namespace 隔离。
- 可信资源的版本批准/快照、不可变 runtime 安装、完整 worker/model secret 边界、聚合 CPU/RSS/PID、网络出口与后台作业/端口。
- Python/uv 与可选 PowerShell 的实际工具链授权/平台测试；目前没有宿主自动回退。
- 观察/审批/native command contracts、HTTP auth、Web 真服务；extension-handled 非 user-entry 结果仍 unknown，需专门的 command receipt。
- 文档 preparation/use cases、DocAtlas Pi tools 与真实 PDF/引用/选区闭环；当前无文档准备明确拒绝伪造来源准入。
- Flash source/probe 保留 ae16956；正式 provider、generation、raw/merge/full/真实质量与资源集仍未接入。

本批未调用真实模型、未修改用户数据库、未修改 .sources/pi。完整 R1–R7 没有缩减，不能把这些局部通过变成全部完成。
