# 原文选区到一次性 Pi 提交

> 2026-09-09 · 第十四批 · [ADR-037](../docs/adr/037-product-selection-tickets.md)。完整目标继续；未声明R3/R5/R7全部完成。

旧SelectionService依赖DSH用户事件/marker与内存nonce/turn-step，不直接迁移为产品恢复语义。新增Core验证器与server
SelectionTickets/ProductSelections。服务器读取Library授权的同版物理页，最多十个游标窗口/200k字符，严格核验每个
block/position/representation hash；仅折叠排版空白、保留Unicode scalar映射，不做模糊匹配/跨页重锚。唯一候选交回
现有resolve核对exactText、source hash、页、位置与quote hash。截断/重复/缺失/权限变更/版本漂移均不能成为票据。
每个stage用独立cache-only sidecar，不共享带upload import grant的进程。abort/断连也等实际namespace join才释放四个
并发槽之一；确定性延迟join测试证明连续取消不能绕过槽位，且不影响其他conversation的文档模型执行或Library导入。

票据持久SQLite FULL事务，单独于native JSONL和canonical Evidence；stage幂等键、actor/workspace/binding/generation、
resolved locators与verified text均有身份/shape/跨字段/hash核验。15min有效期、8 ticket/整组8000字符、1024票据容量。
prepare整组校验后事务绑定submission ID/request hash；native消费前再次核验全部source/policy/expiry再标记consumed。
cancel/failed/TTL不会让另一submission复用旧绑定；显式重选才产生新票据。终态retention/GC管理仍待，不虚称无限可用。

DocumentSession通过可选SelectionAdmissionPort加入modelText与消费回调，prepared.selectionContextIds保留完整组。
引用数据明确包在untrusted source data说明中，不替代系统指令、不自动创建Note/Evidence/Claim。创建票据不改正在执行
的source frame。真实worker的消费回调失败测试确认后续模型调用0、native effects已join、receipt outcome-unknown。
可信resource preflight仍可使用其明确批准的权限，不把该测试误读成禁掉所有extension原生效果。

Live PDF文字选择先显示待核验选区，再显式核验加入；新增有界多选区托盘、移除/本地忘记和回原文定位。stage回包丢失
后保留原键，刷新不会自动POST；确认回执后加入ticket。正在核验时阻止提交竞态，uncertain submission锁定原ID/source
组；只有matching durable receipt才清one-shot托盘，下一问题保留source refs但不隐式重复选区。旧键/过期票据不以
浏览器文本替换。已保存用户消息优先展示对应持久问题，完整native enriched输入可展开，不另造会话历史。

测试含：真实两文档all-or-none核验、坏组无部分ticket、验证过程权限撤销无落库；private票据重开、跨actor/binding拒绝、
绑定到其他submission拒绝、consumed不可prepare、组中一个过期时另一个仍staged；Unicode astral+跨行空白、
存储hash篡改和prepare后/consume前policy撤销，失败仍保持原bound票据不部分消费；
歧义/截断/representation hash阴性；browser outbox ID锁定与回执消费。真实PDF.js→stage丢包刷新→托盘→原文高亮→Pi
模型输入含票据/文字→consumed全链路通过。桌面/390宽截图已生成；图片工具仍不能呈现其URL，未冒充人工视觉验收。

PageIndex在线main仍ae169566，vendor保持clean。再次核对Flash README：默认summary/expand是需模型的增强，raw/merge
是当前已接通的确定性导航；增强必须独立Pi-governed budget/job，不能为“更新功能”偷偷把模型凭据/agent loop放回Python。
本轮不宣称summary/expand或全部Flash质量门禁已过。继续结构化Answer/citations、pin/region/Compare、R4–R7/部署恢复。

旧native测试的800ms曾同时作用于deadline、output、manual stop和后续读文件，负载下后者会先撞deadline；现拆成
独立800ms真实超时/join断言与独立输出/手动取消/显式resume断言，并在等待ready时捕获提前退出。未修改生产限额。
最终 `bash scripts/check.sh` 全部通过：103 JS文件、664 passed/1 skipped、211 Python（99.42s），包括冻结合同/pack/
Pi24指纹/Flash82文件与25函数。浏览器live7、原型14、旧Reader6均通过；整体产品验收仍不能由这些fixture测试代替。
