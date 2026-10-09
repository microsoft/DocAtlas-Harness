# 配对真实聊天页面与浏览器回归

> 2026-09-09 · 第十一批 · [ADR-034](../docs/adr/034-live-chat-client.md)。完整目标仍未完成。

apps/web新增live.html入口，与原有index/DemoApp分开。沿用已接受的chat-first视觉语言，登录、会话列表、真实输入、
普通/steer/follow-up、原生活动、停止、连接状态和saved/provisional分层都调用实际产品API，不使用classifyAnswer或
模拟执行timer。PDF上传/证据Reader/完整管理未接入时明确说明，不用Demo原文或引用伪装成真实后端结果。

新增actor/workspace隔离的conversation listing与keyset分页。Browser validator从同一JSON Schema生成静态ESM，含
语义身份校验，严格CSP无需eval。实测构建暴露AJV CJS default互操作问题：Vitest能过但production bundle报helper非函数，
已在生成器规范化默认导出。字体改为外部self资源，未放宽CSP。生成源纳入check-generated gate。

LiveClient用epoch阻断旧会话/注销后的迟到请求；snapshot取回期间有界缓存SSE，检查generation/epoch/sequence并对gap
重新拉取，不自动submit。原文/原submission key只在此tab按actor/workspace/conversation存储，不存配对码/CSRF/cookie/
模型凭据。只有requestHash/conversation/generation匹配的持久receipt才能清空输入；HTTP响应丢失时保留原键，用户明确
重试才再次POST，server幂等确保只跑一次。SSE ack早于HTTP回包也不产生伪失败；logout清界面与所属草稿，不伪称停止服务器。

真实浏览器测试使用built live页面、strict CSP、实际ControlStore/HTTP/SSE/isolated Pi/native namespace；模型明确为faux。
三个场景包含配对→真实native checkpoint→刷新不重跑、响应丢失/原键重试只调用一次、真实模型abort/zero active effects/
注销、HTML文本不执行及1440/768/390宽度axe/无横向溢出。测试凭据只用于已销毁的临时服务；失败trace仍视为私有测试产物。

另有纯reducer/client tests：重复/缺段/不同scope观察、不可变snapshot、标签页草稿解析、canonical hash、刷新不自动提交、
迟到snapshot/SSE与SSE先到ack、刷新恢复所选会话、logout确认前禁止再次交换cookie；server listing验证另一actor/workspace不可见。实际browser bundle验证与Node单测各自保留，
不能用后者替代前者。整仓首跑遇旧native测试默认1秒marker等待在负载下超时，明确等待ready上限5秒；未改变生产超时
或1/10/100ms取消断言。

未新增默认运行命令/部署、未迁用户DB或重命名workspace；PageIndex main在线仍ae169566，Flash vendor未改。接下来仍是
可用的持久会话/runtime管理、上传/Library/Reader/selection/Answer真实闭环，以及原计划R4–R7、Flash增强/全质量评估。
