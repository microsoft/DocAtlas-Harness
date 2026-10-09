# 运行时管理、新建会话与原生文件恢复

> 2026-09-09 · 第十二批 · [ADR-035](../docs/adr/035-managed-session-reopen.md)。全目标与R7监督门禁仍未完成。

新增RuntimeCatalog，与ControlStore和Pi JSONL分开。目录保存binding/session/actor/workspace、私有basename、关闭时的
文件seal及owner token hash；SQLite FULL事务在启动worker前领取claim。active claim不按TTL失效、不按PID猜测清除，
另一manager/process不能直接接管。仅在coordinator结束、真实worker namespace/native效果join、文件+目录fsync后释放。

RuntimeManager为可信应用装配bounded lazy runtimes、资源approval、LinuxExecutor、Pi、coordinator、observation和可选
document services。同一会话并发lookup共享一个worker，目录由应用生成而非浏览器输入。关闭失败时不会将claim写成clean，
也不会借恢复旧实例之名清理另一个writer epoch。未知/已dispatch记录不盲重跑；可恢复的predispatch请求重新准备权限。

正常关闭后，严格验证原JSONL UTF-8、大小、header/version/session/cwd、无重复/断裂/循环的拓扑、全文件hash和seal；
使用官方SessionManager.open恢复。父进程和worker两边验证，没有重建/截断/修复原生历史。恢复模型不可用就拒绝，不静默
换模型；thinking与context仍走原生SDK。公开文本仍取最后验证的product checkpoint，完整失败历史/分支浏览不是本批声明。

真实隔离Pi测试关闭全部store handles和旧worker后重新打开，确认文件路径与旧字节/entry IDs不变，第二轮真实模型输入
包含第一轮user+assistant和新问题。旧completed/cancelled提交重试不再调用模型；停止的native上下文也保留。篡改原文件
被拒绝且不会重新seal洗白。另测unclean claim跨连接保留、伪claim拒绝、非法UTF-8/foreign header/坏拓扑拒绝。

新增POST /api/conversations及live「新建会话」。creation key按actor/workspace规范hash映射到conversation ID，native
session ID由server签发。浏览器保留未确认的创建键，核对返回identity后才切换；实际HTTP响应丢失测试重试只建一个会话。
页面不会传路径、approval或provider对象。旧原型与DSH保持独立。

全量负载暴露已有SandboxProcess grace timer竞态：namespace init尚存在（包括待回收zombie）时杀掉monitor会丢掉reaper。
修复为先杀实际namespace，保留可信monitor直到namespace identity确实消失/变化，再允许兜底结束monitor。保持原0/1/10/
100ms实际PID移除断言，并补确定性timer测试；未放松停止证明。

边界：本批支持已验证正常关闭后的cold reopen，不把异常主进程死亡当作已恢复。跨主进程强制崩溃/cgroup监督与人工核验
仍要完成；无浏览器强制清claim端点。活动runtime容量有上限，完整close/branch/history控制、默认launcher、upload/Reader/
selection/Answer及R4–R7仍待。PageIndex main仍ae169566，Flash算法未虚称新增；继续沿原计划评估其增强功能。
