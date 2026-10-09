# 扩展exec、资源审批与启动早期取消

> 2026-09-08 · 第八批；[ADR-030](../docs/adr/030-extension-execution-and-resource-snapshots.md)；整体目标未完成。

源码事实：官方pi.exec在extension loader直接调用execCommand，不经过原native tools的operations。
现加入loader-scoped extensionExec，工厂执行前已注入；cached factory/inline/pre-trust/final runtime沿用本轮后端。
没改tool定义或原SDK未配置时的exec行为。Patch保留旧20文件，新增4个dist文件与v2 fingerprint；上游checkout未改。

LinuxExecutor新增argv执行，分别保留stdout/stderr、退出码、killed、cwd、timeout/AbortSignal，不拼接shell。
worker取消可等待真正完成的ack，携带原生partial output；不是收到cancel就伪造空结果。真实工厂启动时的pi.exec
访问不到私有transcript，返回真实7退出码/独立stderr/含空格和shell字符的字面argv。

新resource-trust.v1 + ResourceStore将审批绑定到actor/workspace/manifest hash和version。fd-relative读取避免目录
symlink替换绕过，限制32MiB/512文件/24深度/256目录；拒绝credential/config/special/symlink。两个扫描比较源内容，
fsync和rename发布content-addressed快照，SQLite FULL事务持久审批；跨workspace、旧hash、篡改、oversize与坏row拒绝。
目录原文变化生成新snapshot，不把旧approval变成对新代码的授权。

Pi worker必须拿到明确approval，RO挂载snapshot；native read/bash/exec也获得相同已批代码的RO alias，保留skill读取
和相对helper执行能力。原始agentDir里新增的auth.json不会出现，不能改快照代码。审批撤销立即终止关联worker和
host模型/effects，结果为unknown而不是假成功；空snapshot也走显式内部approval。没有新增HTTP或自动信任入口。

发现并修复实际启动竞态：bwrap 0.4的--die-with-parent在PID1/COMMAND启动后才设置，100ms早停可能只杀掉monitor，
子树仍占用stdio，直到自然退出。追到上游C实现后，改读--info-fd child-pid，校验parent/start-time再杀PID namespace，
最后终止monitor；1/10/100ms的早停均纳入真实测试，未增加产品超时掩盖问题。

旧heartbeat测试300ms真实租约在并发负载下先过期，失败后gate未释放使后续cleanup一起挂起。测试现在控制租约clock，
每步仍等待真实heartbeat timer续租，两步跨过初始expiry；finally释放模型gate。checkpoint接入同一个显式clock，
默认仍是真实Date；没有mock Pi loop或heartbeat timer。产品30s租约/过期fence逻辑未改。

仍待：认证approval/UI与跨进程失效广播、项目资源和package闭包、需要在代码目录写state的扩展迁移、完整branch/reload/
cold restore/provider/telemetry/后台/egress/aggregate quotas及真实Web/证据/选区/研究模块。全功能与质量目标没有缩小。
本轮的早停PID保护直接覆盖LinuxExecutor；统一应用到其他bwrap launcher及其启动/撤销竞态仍须专门验收。
PageIndex main再核对仍ae169566；既有Flash文档链路继续在新资源边界下回归，未启用付费LLM或sidecar第二个loop。
