# Flash provider、不可变 generation 与 merge 复用

> 2026-09-08 · 第四批实际实现；完整目标 active。见 ADR-026。

## 版本与采用

再次 `git ls-remote origin refs/heads/main`：远端仍为 ae169566，本地 pin 相同且未修改。采用其 Flash 0.2.10
有限闭包：82 个 vendor 文件，25 个原始 deterministic optimizer 函数和 strip_internal_keys。
复制文件逐字保留；函数按 AST 提取原正文/常量，不重写 merge 算法；依赖漂移/额外文件由 vendor gate 拒绝。
只改 Flash initializer，避免自动导入无关 API；不复制 summary/expand/chat/cloud 默认入口。
新增固定 PyPDF2 3.0.1、sortedcontainers 2.4.0、regex 2026.5.9，root 和 packaged sidecar uv locks 均更新。

新 tree-index.v1 与 TS/Python bindings 区分 build/read、manifest、flat tree data 和分页；22 个共享正/反样例
覆盖错误版本/字段、外来节点、父子页范围、空树、分页和 generation 关系。独立于旧 protocol 1.2.0/document RPC 1.1.0。

## 实际链路

已 ingest 的原始 PDF asset → 校验 document/revision/hash → 独立 Linux Flash worker → 严格 tree data →
fsync/原子发布 manifest+data+seal。raw/merge 使用不同 generation，node ID 带 generation；旧原文、FTS、block map 不切换。
merge 对同一 raw 的父版本关系可重算验证；metadata seal 检测 toc_source/质量字段等篡改，不只检查节点文件。
失败/取消不冒充 ready；合法空输出为 empty。导航树没有 bbox，没有自动成为证据。

DocumentService 提供 opt-in build_tree/read_tree；另有已打包的单任务 docatlas-tree 命令。CLI 只接受 source identity，
不接受模型/浏览器给出的路径。旧 RPC capabilities 不冒称新 tree reasoning search 已接通。
成功 wheel-only 实验在 uv 隔离环境、`python -I` 下运行：只导入已安装 wheel，不导入仓库源码，六页 PDF 的 merge 生成 ready。
初次 offline 依赖解析缺少缓存，正常依赖解析后成功；不是运行期向云上传 PDF 或调用模型。

## 原生资源边界

worker 在 bwrap 的 user/PID/network namespaces 内，只挂 PDF、算法代码和 Python/runtime 依赖为 RO；私有 cache/控制/凭据不挂入。
清洁 env；CPU/address-space/wall/output/FD 上限；明确 workers=1，不使用 >=64 页时的自动 CPU-count fanout。
libseccomp 禁 fork/clone/exec/socket，防 native 解析器绕过 Python audit hook；启动时还用 native syscall 验证 socket 被拒绝。
无隔离能力时 fail closed；取消/超限先终止并等待真实子进程，不只翻状态。65 页重复样本通过，空树仍不等于质量达标。
这不等于整个 Pi/扩展/模型/产品已完成安全验收，也不等于对所有恶意 PDF 或内核缺陷的绝对安全证明。

## 性能改动和同结果验证

合并不再重复 PDF 解析：从已校验 raw generation 重建算法需要的结构，仍运行同一 merge/same-page/relabel 函数。
worker 不重造原文、摘要或 geometry。与重新解析+merge 的完整树数据（含全部 keyItems/node IDs）和统计逐项相等。
下表为单机一次运行，包含隔离/输入校验/发布开销，排除事先 ingest；不是整体导入或检索质量 benchmark。

| PDF | 页 | raw→merge 节点 | raw 秒 | 复用 raw 的 merge 秒 | 重新解析的 merge 秒 | 数据/统计相同 |
|---|---:|---:|---:|---:|---:|---|
| q1-fy25-earnings | 22 | 28→18 | 4.041 | 1.393 | 4.167 | 是 |
| attention-residuals | 21 | 34→16 | 9.043 | 1.387 | 9.235 | 是 |
| annual-report-truncated | 50 | 55→41 | 6.446 | 1.375 | 6.186 | 是 |

Provider fingerprint：de5e89a906069e7bba63f61f4d820f7304a0d29db98a2a395a435190fb2a8ef5。
worst-case routing cost 估计分别为 6→6、7→6、6→6；这是上游代价模型，不是检索准确率或真实 token/cost。
复用路径的时延改善只针对已有 raw 的 merge 阶段；节点更少、范围合法都不能代替召回/引用正确率验证。

## 仍未完成

完整 multilingual/mixed/OCR/Type-3/超长真实质量集，legacy/raw/merge/full 同条件质量与成本对照、跨平台资源矩阵；
Pi-governed summary/expand jobs；R2 reasoning tree adapters、文档统一准入和 Web 真实链；R1 完整运行安全与 R4/R6/R7。
provider 仍 opt-in，不设置为全局默认，不删除现有 provider，也不把 research fixture 当成生产服务。
