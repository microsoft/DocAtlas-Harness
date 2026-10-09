# 会话快照与有界SSE观察

> 2026-09-08 · 第十批 · [ADR-033](../docs/adr/033-conversation-observations.md)。完整目标继续，不改默认launcher。

在现有配对认证HTTP上新增snapshot/events。Snapshot只同步组合当前ControlStore记录、受验证checkpoint文本投影和
有界provisional状态，游标是conversation generation + random stream epoch + sequence。recent receipts按最近32条读取，
before只在同一授权conversation内翻页；旧generation/另一workspace、非法cursor不混入当前观察。

PiProductDriver在真正消费user消息时绑定progress归属，assistant消息有独立live id；官方text/tool事件仍由Pi生成。
runtime.submit yield分开consumed与progress；专用relay合并同消息文本、限制积压，丢失时resync，不从模型callback等待
浏览器。Parent验证进度合同，Hub只接受已running/cancelling的对应receipt；提交状态变化先由存储commit再通知观察者。

History从同一次prefix/hash/header/branch验证的数据生成，校验重复ID/parent/cycle，只输出user/assistant可见text与entryId。
不输出thinking、system/provider字段、tool arguments/results或绝对sessionFile。已知user entry显示原始产品输入，而不是
DocAtlas加入的model上下文。每个文本/窗口有明确上限和truncated/hasEarlier标记；未把这个窗口称为全部native历史。

SSE保留256个事件/1MiB replay，per-view live/activity及HTTP响应也有上限。不存在/过老/epoch不匹配的Last-Event-ID
收到明确resync，不提交新prompt。每帧重新检查auth+binding；logout立即关闭，idle heartbeat检查过期与generation变更。
慢客户端输出超限被断开，其余model/tool和durable commit不受影响。32条全局SSE、16条Hub、8条session订阅保留命令空间。

真实loopback HTTP测试连actual isolated Pi（faux model）：文本分块→持久receipt→完整checkpoint答案snapshot；断线/replay
不增加model call count，等待模型时断开SSE不会cancel；显式stop才中断实际模型，logout终结stream。初次全量发现测试
错误假设整句在同一delta中；改验证真实文本前缀增量，并独立验证snapshot完整答案，未把分块当最终答案边界。

单测覆盖bounded burst relay、慢response、抛异常的订阅者、缓存溢出/旧epoch、同toolCallId不同submission、过晚progress、
伪receipt callback、recent分页/changed binding、thought/tool数据过滤与篡改文件拒绝。TS/Python共用15组shape/semantic
fixtures；Python只校验合同，不运行新的control/observation loop。PageIndex main在线仍ae169566，Flash vendor未改。

待办仍包括认证前端SSE reducer/重连UI、完整native history分页和cold restore、取消/失败的native文件投影、upload/Reader/
selection/Answer/完整controls与approval UI，以及R4–R7。当前history是最近验证成功的checkpoint；pending/失败/unknown以
真实receipt保留，不将内存草稿或未核验内容标成saved。没有部署开放数据路径或用Demo模拟回答替代真实运行。
