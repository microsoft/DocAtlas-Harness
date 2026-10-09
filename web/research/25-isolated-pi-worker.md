# 独立Pi worker、模型代理与文档链路

> 2026-09-08 · 第七批；完整目标仍active。规范：ADR-029。

此前仅原生I/O/Python在namespace，Pi/runtime/extensions还在宿主。现在新增IsolatedPiWorker，运行真实公开SDK
AgentSessionRuntime，使用RO安装代码、独立filesystem/user/pid/net/ipc、显式workspace/agent/session/output目录。
Core/Control/模型凭据目录不挂载。SDK读取账户信息的真实启动失败已定位，仅补RO passwd/group及明确agentDir；
没有挂宿主HOME、禁用资源加载或退回文档专用tools。

worker-frame.v1是独立内部合同，不复用browser/DSH事件。继承的pipe授予连接身份，JSON不能选择actor/role；
双向method maps分开。UTF-8严格解析、帧/累计输入输出/请求数/期限有界，流序号与nonce+单调call ID拒绝重放；
背压发送，大帧采用线性分段组装。cancel acknowledgement与实际handler quiescence明确分开。

native operations用RPC接原LinuxExecutor，不覆盖tool定义；read/write/edit/bash/grep/find/ls真实测试通过。
grep保留流/kill/limit行为；工具启用用原生setActiveToolsByName。默认工具、retry/compaction与资源发现保留。
可信global扩展真实加载且执行，其probe在worker内看不到宿主私有文件/环境canary。

模型由宿主ModelRuntime执行：worker得到无header/真实endpoint的公开catalog；逐调用确认model与actor，拒绝
header/apiKey及model routing覆盖。原生payload/response hooks通过scoped callback跨IPC，code仍在worker；
agent-loop hooks仍本地执行，不能把整个Agent config里的functions发给宿主。响应cookie/auth不回传。
测试确认provider回调PID都是宿主PID，工具/扩展在worker；faux只用于模型，不是工具或checkpoint替身。

文档tools也接入worker：runtime session校验、Scope/Core全部留在宿主，prepare/consumed顺序仍有效，图片bytes
显式编码跨IPC。真实Library PDF→Flash merge/search/page+visual→native checkpoint经过独立worker；不回退到本地
Agent对象。这不是最终Answer/Evidence/UI编译完成。

4个真实集成场景覆盖native/扩展/checkpoint、宿主模型取消后新提交、真实PDF/Flash/image、已有副作用后的SIGKILL。
最后一种进入outcome-unknown且不自动重放。宿主校验实际native JSONL前缀，而不是相信worker自报saved-success。
7个peer/broker/checkpoint测试覆盖方向、流/取消、UTF8/字节、重放、model/credential policy及真实文件前缀/篡改/分支；
11组shared frame fixtures在TS/Python验证。

仍未关闭：官方pi.exec的专用第二层路由（当前受整个worker边界约束）、可信资源审批/不可变快照、完整native控制/
切分支/冷重建/导入导出、deferred/自定义provider/fetch/更广model options、provider回调/telemetry完全parity、后台/出口/
聚合CPU/RSS/PID/磁盘额度、HTTP/auth/Web与R2–R7。内部worker不是生产部署或完整安全认证。用户数据库未迁移。

PageIndex main再次在线复核仍ae169566；有限vendor未改，Flash已通过新worker→宿主document→隔离Python链路。
测试模型与真实文档/执行/磁盘证据保持区分，没有暗中开启付费LLM或Python里的summary/expand。
