# 文档进程双层隔离

> 2026-09-08 · 第六批实际实现；完整目标仍active。规范：ADR-028。

上批Node launcher只有清理env/process-group管理，本批将DocAtlas新路径的整个协调进程放入bwrap空根目录：
独立user/pid/net/ipc、runtime/code/source只读、仅cache可写；Core domain与ControlStore目录自动拒绝重叠挂载。
其余模型/profile私有目录由应用配置protectedRoots，不能放进获准runtime/source/cache内。元数据探测使用异步、
10秒有界、无文档输入的uv启动；运行期间不下载/安装依赖。现有环境的bwrap是0.4.0，未假设新版本CLI能力。

会话read supervisor不再挂载原始source roots。新增显式cache-only CLI模式，仅广告/接受search/read/resolve，
不拿空目录冒充可用ingest。Library仍是独立进程，取消/恢复按原有会话边界执行。

仅把整个cache挂进去还不足以隔离恶意PDF。因此另提取原有pypdf/PDFium算法为pdf_native：extract/locate/render
都在只挂载单个文件的worker执行。协调进程不再导入pypdf/PDFium。源hash解析前后核对；父端校验response身份、
页数、PNG格式/长度/hash/尺寸、geometry空间及边界。原件和FTS/资产发布仍由可信协调进程负责。

worker共用seccomp guard（扩展禁用mount/ptrace/IPC/memfd等），无fork/exec/socket；CPU/AS/FD/输入/输出/时限有界。
bwrap 0.4不支持--size，因此没有使用无效配置或忽略错误，而是使用只读tmp/dev及内存PNG编码，避免可写临时目录。
与原生算法比较：六页PDF全文相同、PNG逐字节相同、正向定位框相同。旧PDF matrix继续覆盖旋转/扫描/混合/异常等。
模拟被利用的解析器通过真实libc调用验证fork/socket/memfd失败；看不到同目录第二份文档、父进程、私有env，不能写tmp。

Flash vendor维持ae169566（再次在线核对main未变）；共享guard纳入provider fingerprint。raw/merge canonical结构与
既有缓存/代际规则未改，摘要/扩展仍留给显式Pi作业。新增4个模块补入独立runtime清单，check现在拒绝任何未打包的
顶层Python模块；installed-wheel探针同时执行真实ingest、visual与Flash merge，不仅检查本地目录。

该批不宣称所有安全项目关闭：协调器仍是TCB并访问获准cache，完整Pi/model/extension/网络策略、聚合磁盘/资源额度、
非Linux等价边界、HTTP/auth/upload/selection/Answer/真实Web与R4–R7仍须逐项完成。未新增公开路由、未修改用户DB。
