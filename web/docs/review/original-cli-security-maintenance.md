# 原 Python CLI 依赖安全与行为复核

日期：2026-10-10。基线：`824694a`，独立集成分支 `feat/grounded-web`。

用户在独立 Web 审查后单独授权处理原 CLI 的依赖告警。本记录不改写
[上一批审查](grounded-web-code-audit.md) 的历史结论；本批不 push、不改官方 main、
视频工作区、兄弟 checkout、真实 PDF、既有 Markdown 或运行数据。

**结论边界：安全修复候选可运行，但不是 Docling 输出完全等价的证明。**
原 CLI 的本机全套 200 项测试通过；锁定的当前平台运行时 138 个包无已知公告匹配，
全部条件分支的 148 个运行时包版本也逐项核验无已知公告匹配。
Docling 的实际段落划分和图片裁切发生变化，合入前必须明确接受这个差异，不能把
“测试通过”或“合成样本包含相同文字”当成质量/实验性能不变。

## 依赖与代码范围

| 包 | 旧锁版本 | 新锁版本 |
|---|---|---|
| anyio | 4.13.0 | 4.14.2 |
| docling / docling-slim | 2.97.0 | 2.132.0 |
| fsspec | 2026.4.0 | 2026.6.0 |
| PyJWT | 2.13.0 | 2.15.1 |
| pypdf | 6.16.1 | 6.19.0 |
| urllib3 | 2.7.0 | 2.8.0 |

升级前复核为 135 个当前平台运行时包、6 包 37 条公告匹配。没有 ignore 列表，也没有
删除功能或跳过脆弱包来让审计通过。安全下限进入 `project.dependencies`，因此会写入
wheel 的 `Requires-Dist`，不只约束本仓的 uv 解析。

这是按已修复下限进行的定向安全维护，不是全面追新；检查时 PyPI 的 Docling 最新版
为 2.137.0、parse 为 7.22.2，本批没有把这些未经同一轮比较的版本混入锁文件。

Docling 的必要兼容闭包更新到 core 2.99.0、parse 7.22.1、ibm-models 4.0.2；新的上游
闭包还涉及 doclang/langcodes/python-oxmsg/olefile，去掉不再需要的 jsonlines。
RapidOCR 只升到要求的 3.9.1；OpenCV 换为上游所需的 headless 发行包，但保持
4.13.0.92 的绑定版本，未采用解析器最初自动选择的 OpenCV 5。完整新旧安装版本见
[基线测量](cli-dependency-baseline.json) 与 [候选测量](cli-dependency-candidate.json)。

OpenAI 2.41.0、Azure Identity 1.25.3、Torch 2.13.0、Transformers 5.10.1、PyMuPDF
1.27.2.3 保持不变。Python 支持仍是 `>=3.10,<3.14`；本机执行使用 CPython 3.12.12 /
uv 0.9.21，CI 保留 3.10–3.13 矩阵。没有运行其他 Python 版本或远端 CI，通用锁可解析
不等于这些平台都已经实跑通过。

生产代码仅将 `build-md` 的 Docling `allowed_formats` 限定为 PDF，与其现有 `--pdf`
入口一致；拒绝伪装成 PDF 的 Docling JSON，不能转而调用 JSON/HTML 等后端。有效 PDF
的 CLI 参数、images-on/OCR-off 默认、逐页目录、跳过已完整生成文档、原子替换/回滚
规则不变。没有修改 Read/Search/Note/Review、模型调用、PageIndex vendor 或独立 Web
运行时代码/锁文件。没有为匹配两个样本硬编码分段或裁图修补。

## 无修复版本公告的复核

旧审计的 `PYSEC-2026-4146` / `GHSA-gvp8-978c-rx2q` 没有列出修复版本。这不是
继续使用旧版或全局忽略公告的理由。已检查实际安装的 PyJWT 2.15.1：
`_merge_options()` 先复制调用方的 options，随后才设置不验签模式的 defaults。

新增 `decode` / `decode_complete` 两项回归，在旧 2.13.0 环境都因 options 被原地修改
而失败，在新环境通过，并验证切回正常验签后确实拒绝过期 token。另检查深嵌套 header
返回 `DecodeError` 而不是泄漏 `RecursionError`。所有 token/签名 key 都是测试内合成值。
旧 MSAL 1.37.0 的 PyJWT 调用是 `encode`；DocAtlas 的 Azure CLI 凭据入口并不直接
调用这条复用 options 的 decode 路径。以上是依赖行为和调用链证据，不是泛化的认证安全证明。

## 真正测到的行为差异

只使用仓库自编的 `sample_report.pdf` / `sample_report_prior.pdf`，各 6 页；新旧输入
SHA-256 相同。不读真实文档、不下载模型、不调用 Azure；Docling 使用现有 HuggingFace
缓存，强制 offline / CPU / 4 threads，正常 images-on、2.0 scale、OCR-off。

两轮复核中，每个环境内部的输出均保持确定性；第一轮和增加重复次数后的输出 hash
也相同。跨环境比较结果：

- 四个 CLI 帮助入口（root / build-md / build-tree / chat）stdout/stderr 字节相同。
- 两份 PDF 的 12 页 Read 文本、标签、页数完全相同。
- 通过原有 PyMuPDF Read 图片路径渲染的 8 张页图字节相同。
- Docling 每份仍生成 6 个 Markdown 和 1 张图；表格页等 4 页 Markdown 字节相同。
- **第 1 页段落分组改变**：报告副标题与前几行正文合并，末行另起段。
- **第 5 页列表分组改变**：原先单列的里程碑标题/条目合为一段，保留列表连字符。
- **第 4 页图片裁切改变**：从 528×266 变成 539×280；人工核对该合成图的四组标签/
  数值仍在，但像素和裁切不是同一结果。

定位到上游默认 `PdfFormatOption.backend` 从旧非线程 DoclingParse 改为
`ThreadedDoclingParseDocumentBackend`，layout 也迁到 object-detection 流程。
旧 V4 backend 名称在新版只是新实现的别名，并不能恢复旧输出。没有通过忽略换行/
标点或仅比较关键词来把这项差异变成“通过”。旧 CLI 的 MinerU 外部 Markdown 入口
与论文重现路径未改；这不意味着 Docling 新旧生成物可以互换复现实验。

## 性能观察，不是等价验收

可重复脚本：[`scripts/benchmark_cli.py`](../../../scripts/benchmark_cli.py)。同机顺序运行，
CLI/Read/渲染各 9 次，Docling 每份各 5 次；表中为去掉本测量首轮后的中位数。
原始样本和全部结果 hash 存在上述两个 JSON 中。没有清空操作系统/模型缓存，因此
不能把首轮称为严格冷启动。测量期间不运行本任务的构建或全套测试。

| 操作 | 基线 | 候选 | 观察变化 |
|---|---:|---:|---:|
| CLI root help | 120.05 ms | 119.29 ms | -0.63% |
| CLI build-md help | 121.99 ms | 118.33 ms | -3.00% |
| CLI build-tree help | 119.02 ms | 119.79 ms | +0.65% |
| CLI chat help | 120.74 ms | 119.22 ms | -1.26% |
| Read，2025 | 11.55 ms | 11.44 ms | -0.98% |
| Read，2024 | 11.26 ms | 11.49 ms | +1.99% |
| 4 页渲染，2025 | 176.85 ms | 174.58 ms | -1.28% |
| 4 页渲染，2024 | 180.71 ms | 177.26 ms | -1.91% |
| Docling 6 页，2025 | 7.956 s | 6.756 s | -15.09% |
| Docling 6 页，2024 | 6.795 s | 7.418 s | +9.16% |

共享宿主机存在其他任务，Docling 两份文档的方向也不一致；不能据此承诺性能不变或
声称提速，尤其不能隐藏 2024 样本的 +9.16%。真实语料、OCR、GPU、完整 LLM/评测
性能尚未验收。Read 与 CLI 小样本观察较接近也不是任意文档无回归的证明。

## 本机检查

原 CLI 全套 **200 项通过**（原 168 项 + 本批 32 项）。新增覆盖依赖安全行为、真实 PDF
页号/顺序/文本上限、嵌入 Unicode 字体/旋转/空页、AES-256 空密码与拒绝受保护文件、
Docling 真实类型的表格/图片/空页序列化、选项、失败回滚、伪 PDF 拒绝，以及公开依赖
元数据和性能记录器的确定性/不覆盖约束。

首次新 fixture 失败已单独定位：PyMuPDF 的 predefined CID font 不等于嵌入 ToUnicode
测试，旧解析器也有同一限制；`PdfWriter.__enter__` 会重置构造时的 clone，因此应入
context 后 append。没有改 Read 来掩盖测试，也没有将这些失败冒称升级后新回归；修正
fixture 后 7 项 PDF 边界测试在旧、新环境都通过。旧 JWT 两项应失败的结果单独保留。

最终原 CLI 语句覆盖率 **54.07%**（4498/8319），不是 100%；CI 下限从 25% 提至
50%，并按新下限重跑通过。Ruff 检查/格式、mypy（68 个源文件）、Bandit、ShellCheck、
CITATION 和 workflow schema 校验、四个 Skills 校验、sdist/wheel 构建均通过。

同时修复旧 wheel 冒烟检查的源码遮蔽：改为在隔离安装目录运行，并断言包位于该
解释器的 prefix 内。本机验证四个 Skill、vendor config、六项已发布的安全下限和
真正的 `python -m docatlas --help`；该帮助输出与基线 hash 一致。仅安装 wheel 和
PyYAML 的这项检查不是完整推理/所有依赖的 wheel 端到端测试。

完整 secrets hook 通过。新增两份基准记录的 60 个 Hex High Entropy 告警逐项对应
实际 SHA-256 字段和 scanner 的 hash；只将这些确定的非密钥加入既有 baseline。
合成加密 fixture 的固定测试密码使用单行 allowlist，不豁免目录或停用扫描插件。
baseline 总计 1722 项均有非密钥审计标记。

独立 Web 通过 clean-host 中实际执行的完整 `bash scripts/check.sh`：2782 项 JS、
1494 项 Python；JS 行覆盖率本轮为 77.79%，Python 综合覆盖率 78.58%。Pi 0.85.1
的 24 文件补丁/原生 MCP peer、跨语言协议、Flash 的 83 文件/25 确定函数及包含
109 个源/数据/license 文件的侧车 wheel 全部通过。Web 运行时代码、contracts、
compat、两份锁与 `824694a` 零差异。本批没有重跑浏览器旅程；上一批的 56 项结果
仍是 2026-10-09 的历史结果，不冒称本轮新执行。

### 实际检查入口

以下在仓库根运行，Python 命令均先清除继承的 `VIRTUAL_ENV`，工具通过
`uvx --python 3.12.12`，项目解释器由 locked sync 固定为 3.12.12：

```bash
uv lock --check
uv sync --locked --extra dev --python 3.12.12
uv run --locked --no-sync pytest
uvx --python 3.12.12 ruff==0.16.5 check --extend-exclude web .
uvx --python 3.12.12 ruff==0.16.5 format --check --extend-exclude web .
uv run --locked --no-sync --with mypy==2.3.1 mypy docatlas
uvx --python 3.12.12 bandit==1.9.4 -q -r docatlas -x docatlas/_vendor
uvx --python 3.12.12 --from shellcheck-py==0.11.0.1 shellcheck scripts/*.sh
uvx --python 3.12.12 cffconvert==2.0.0 --validate -i CITATION.cff
uvx --python 3.12.12 check-jsonschema==0.38.0 --builtin-schema vendor.github-workflows .github/workflows/*.yml
uv run --locked --no-sync --with pytest-cov==7.0.0 pytest -q --cov=docatlas --cov-fail-under=50 --cov-report=term --cov-report=json:/tmp/docatlas-cli-security-LDzKtG/coverage-final.json
uv build --python 3.12.12 --out-dir /tmp/docatlas-cli-security-LDzKtG/dist
```

另外分别执行 `uvx --python 3.12.12 --from skills-ref==0.1.1 agentskills validate`
的 `docatlas/skills/search`、`read`、`note`、`review` 四个输入。secrets 使用
`git ls-files --cached --others --exclude-standard -z` 的完整文件集合，通过
`uvx --python 3.12.12 --from detect-secrets==1.5.0 detect-secrets-hook --baseline .secrets.baseline`
检查，包含本批尚未提交的新文件。

当前平台依赖扫描：

```bash
uv export --locked --no-dev --no-emit-project --format requirements-txt --output-file /tmp/docatlas-cli-security-LDzKtG/final-requirements.txt
uvx --python 3.12.12 pip-audit==2.10.1 --progress-spinner off --disable-pip --require-hashes --strict --format=json -r /tmp/docatlas-cli-security-LDzKtG/final-requirements.txt -o /tmp/docatlas-cli-security-LDzKtG/final-audit.json
```

额外核验同一 export 中每一个唯一的 `(name, version)`（不按当前平台过滤），使用
同版 pip-audit 的 `PyPIService.query(ResolvedDependency(name, Version(version)))`。
148 项全部可解析、没有 skip、没有已知公告匹配，包括两套 NumPy/pandas/networkx。
直接去掉 marker 后交给 requirements CLI 会因重复包名被拒绝，所以没有把那次失败
伪报为审计成功；这是逐版本 metadata 查询，不代表其他平台已实际安装/测试。

在 `web/` 下运行 `scripts/pnpmw run check:clean-host`，内部在真实隔离命名空间执行
`bash scripts/check.sh` 并等候全部 join；没有改超时或绕过断言。全检之后又只读复核
`scripts/pnpmw audit --prod --json` 和显式侧车 member 的安全审计：

365 个 Node 生产/可选依赖、12 个实际 Python 侧车运行时依赖均无已知告警。没有把
Web 虚拟 uv 根的空导出当成侧车审计；pnpm wrapper 的 Node 提示行也不属于 JSON 数据。

```bash
uv export --locked --package docatlas-dsh-sidecar --no-dev --no-emit-workspace --format requirements-txt --output-file /tmp/docatlas-cli-security-LDzKtG/web-sidecar-requirements.txt
uvx --python 3.12.12 pip-audit==2.10.1 --progress-spinner off --disable-pip --require-hashes --strict --format=json -r /tmp/docatlas-cli-security-LDzKtG/web-sidecar-requirements.txt -o /tmp/docatlas-cli-security-LDzKtG/web-sidecar-audit.json
```

最终合入判断仍须明确接受以上 Docling 差异；没有实际 Azure 调用、真实语料、OCR/
GPU、远端 CI 或公开部署验收，不关闭任何长期恢复 gate。没有修改真实生成物，
也没有执行远端 push。
