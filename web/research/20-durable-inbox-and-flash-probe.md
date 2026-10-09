# 持久提交闭环与 Flash 有界探针

> 2026-09-08 · 持续目标第二批实现。
> 状态：内部控制模块/原生 checkpoint/故障注入已实现，正式 Web、权限/隔离编排与 Flash provider 仍未集成。

## 1. 从“复现丢首问”到“保留输入并正确恢复”

上一批实测 Pi 在第一个 assistant 前不生成会话文件。现在 `apps/server` 是可构建包，提供独立 ControlStore，
在 SQLite WAL/FULL transaction 提交后才返回接收 receipt，暂存原始输入与来源/选区引用。
Pi 原生 JSONL 仍是唯一会话历史；control DB 不是研究 Memory 或第二个长期聊天记录。

实际完成：

- product-control v1 canonical schema 与 TS/Python bindings/共享 fixtures；独立于旧 DSH session/turn。
- owner/workspace、binding generation、幂等键/内容 hash、CAS、32 个 pending 上限、受权分页。
- 单 writer capability/epoch，只落 token hash；租约过期不会自动抢占仍可能存活的 worker。
- 全部来源/选区引用一致才 ready；dispatch intent 必须先落盘；恢复的 ready 请求重新准备。
- 取消请求和真正停止分开；已执行不明进入 outcome-unknown，不盲重跑，也不以取消按钮清掉未知副作用。
- checkpoint 绑定真实 Pi session/user entry/branch/leaf，核对实际文件和内存内容，file/directory fsync 后才保存成功。
- 原生 user entry 不可复用来证明另一个提交完成；完成后才能逻辑删除恢复副本，WAL/备份不宣称物理删除。

代码：`apps/server/src/storage/control-store.ts`、`packages/runtime-pi/src/checkpoint.ts`。
正式 HTTP/认证端点尚未开启；actor、lease、checkpoint、recovery 等内部 API 不能直接暴露给浏览器或 worker 自报身份。

## 2. 真实进程实验

`apps/server/test/pi-inbox-integration.spec.ts` 用固定公开 Pi SDK、faux provider 和真正子进程验证：

| 中断位置 | 磁盘事实 | 恢复结果 |
|---|---|---|
| control 已接收，Pi 未 dispatch | Pi 文件不存在；输入已在 control DB | 确认子进程 SIGKILL 退出后恢复，在原 native session ID 下执行一次并保存 checkpoint |
| dispatch 已记录，首次模型回复前 | Pi 文件仍不存在；输入和 dispatch 状态都在 control DB | outcome-unknown；原问题可取回，自动重放被拒绝 |
| 正常 Pi 最终回复 | 文件/当前 branch/user entry/hash 一致 | checkpoint 后完成，再清理临时输入；原问题仍在 Pi 文件 |
| 会话文件被修改/损坏/超限 | 与 live Pi entry 或资源限额不一致 | checkpoint 拒绝，不标 saved success |

这是进程崩溃与真实文件行为，不是 UI mock；没有真实模型费用。但不能据此声称机器掉电、所有文件系统、
完整多步骤 domain settlement、所有 steering 聚合或任意外部副作用均已解决。

review 发现并处理：

- JSON Schema 在 Ajv strict 模式下需要局部声明 required 的属性，不能仅靠父 $ref 推断；未关闭 strict 校验。
- Python strip 与 JS trim 对 BOM/少数控制字符不同：绑定实现统一为 JS whitespace 语义并加入共享 BOM fixture。
- 不能在恢复后沿用 ready 的旧选区/权限准备状态，必须重验。
- 不能用上次相同问题的 native user entry 为新请求签发完成 receipt。
- 控制库只能校验 capability/epoch，不能凭租约推断 OS worker 已退出；`recoverAfterExecutionStopped` 的调用方仍有真实终止证明义务。

## 3. Flash 资源与新增结构能力

新增可复现研究脚本 `scripts/probe-flash-boundaries.py`，对固定 PageIndex `ae16956`：

- 使用 pinned internal `extract_toc(workers=1)`，避免 public API 不暴露 worker 上限的问题。
- CPython 3.12.12，CPU 90s、address space 2 GiB、128 FD 上限；audit hook 拒绝网络和额外进程创建。
- 只创建虚构样例派生 PDF，不读写用户原文，不调用 PageIndex Cloud/LLM，也不导入另一套 chat loop。
- 测真实 raw、书签融合、忽略书签以及 >=64 页路径；验证 tree 页范围/深度/数量有界。

首次执行结果（包含进程内缓存影响，不是算法提速对照）：

| 样本 | 页 | 节点 | 结果 | 秒 |
|---|---:|---:|---|---:|
| sample raw | 6 | 5 | detected | 0.302 |
| 同文档加入书签 | 6 | 6 | hybrid；融合生效 | 0.042 |
| 忽略新增书签 | 6 | 5 | 与 raw tree hash 相同 | 0.036 |
| 重复内容构造的长 PDF | 65 | 0 | empty tree，非可用索引 | 0.359 |

进程峰值 RSS 133,080 KiB。四项没有非法页范围；零节点不能由此证明质量好。脚本明确报告 empty，
不把它包装成全文索引成功；真实长文档/中文/多栏/扫描/OCR/merge/full 的质量与资源验证仍在 R5 队列。

运行：

~~~bash
env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar \
  --with sortedcontainers==2.4.0 --with PyPDF2==3.0.1 --with regex==2026.5.9 \
  scripts/probe-flash-boundaries.py
~~~

额外依赖只在 uv 临时环境，没有安装整套 SDK chat 依赖或改变 Python 项目 lock。脚本可读 `.sources` 是研究例外，
生产构建仍禁止 import checkout；正式 provider 需要固定依赖/最小 vendoring 的 provenance 与更新机制。

## 4. 下一执行面

继续 R1：权限感知的准备服务、持久调度/heartbeat、native/session/credential 全边界、approval/stream/reconnect 与完整 Pi 控制映射；
接真实 Web 后再做 R2/R3 文档闭环。R5 接固定 Flash provider、raw/merge generations 与长文档/书签/失败质量集。
R4–R7 完整需求不删减，当前没有“全部完成”的证据，目标保持 active。
