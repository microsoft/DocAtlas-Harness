# 全进程启动取消与认证HTTP首链

> 2026-09-08 · 第九批；[ADR-031](../docs/adr/031-shared-namespace-lifecycle.md)、[ADR-032](../docs/adr/032-local-authenticated-http.md)。整体目标继续。

此前早停保护只在LinuxExecutor。现抽为runtime-document的共享SandboxProcess，让Pi worker、native执行、document/tree
coordinator都走同一个info-fd/child-parent/start-time验证。取消先等身份，终止PID namespace，让monitor自行回收子进程，
再等待namespace退出和stdio close。直接同时杀monitor会遗留init zombie，真实PID测试发现并修正；空/非UTF8/超限/伪造PID
不能成为信号目标。0/1/10/100ms启动取消与Pi初始化时资源撤销、两个document命令的立即停止实际运行。

Python的PDF和Flash也统一SandboxProcess，先读实际bwrap身份再用pidfd终止/等待namespace。锁定的Python standalone
未导出os.pidfd_open，实测AttributeError后改为Linux x86_64/aarch64 syscall适配；不退回只killpg。算法/文件grants/内存CPU
边界未变，Flash wall deadline覆盖bootstrap，异常不发布。完整文字/PNG/geometry、raw/merge及65页仍是真文档测试。
Kernel不可中断状态、host死亡/cgroup整体回收与跨平台仍有独立release gate。

新增product-http.v1与内部createProductHttpHandler：应用签发5分钟单用配对码，JSON兑换HttpOnly/SameSite cookie和CSRF。
bootstrap/session bearer只保存hash；会话上限64、有效期有界、logout和重启撤销。不接受客户端actor，不把secret放URL。
精确Origin/Host、loopback HTTP或真实TLS、拒重复安全headers、64KiB body/10s读取/64并发、no-store/CORP和无CORS。
提交、stop前后重新检查会话/归属；只接受既有product-control submission，不暴露任意method/path/approval mutation。

真实loopback HTTP测试使用独立Pi worker+native边界：配对→持久202→回执→native checkpoint；重复提交返回同一receipt且
不多跑模型；第二次模型实际被停止并确认quiescent。跨Origin、错CSRF、伪actor、另一workspace、超大body、坏UTF8、重复
cookie、query秘密、配对重放全部被拒。模型仍明确faux，不称真实模型回答质量。会话/CSRF/过期另有单测，HTTP DTO共用TS/Python fixtures。

这是可组合的真实HTTP handler，不是已部署入口：没有新增默认listener/launcher或将Demo接成生产界面。SSE/会话快照/
登录UI/上传/Reader/选区/Answer与完整native controls下一步继续；原DSH、wire和用户数据没有迁移。
PageIndex main在线复核仍ae169566；没有凭pin更新宣布Flash全增强或质量验收完成。
