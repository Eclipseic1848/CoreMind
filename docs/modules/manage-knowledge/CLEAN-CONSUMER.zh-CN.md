# 干净消费者安装与知识索引重建

本流程覆盖 P1 后续验收。用已合入 P2-A 的固定源码构建本地安装件，随后在独立消费者目录安装 npm tarball 和 Python wheel。知识服务两次从原文建立内存 Qdrant 索引，每次通过 CLI + YAML、TypeScript SDK、Python 同步 SDK 与 Python 异步 SDK 查询。同一问题应引用 `资料室手册-v2.md` 第 5 行。

## 在空目录复现

准备 Node.js 22.19 或更新版本、Python 3.12 和 PowerShell 7.4 或更新版本。让以下命令中的 `python` 指向 Python 3.12。命令从 CoreMind 仓库根目录开始。npm 与 pip 从公开注册表下载第三方依赖，模型取自 Hugging Face 的固定提交。

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = (Get-Location).Path
$probe = Join-Path ([IO.Path]::GetTempPath()) ('cm392-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path "$probe/source", "$probe/packages", "$probe/consumer", "$probe/model" | Out-Null
$revision = '600e4640580bd7e67408ce816330bb4255c308e0'
git archive --format=tar --output "$probe/source.tar" $revision
python -X utf8 -c 'import sys, tarfile; tarfile.open(sys.argv[1], encoding="utf-8").extractall(sys.argv[2], filter="data")' "$probe/source.tar" "$probe/source"

$env:npm_config_registry = 'https://registry.npmjs.org/'
$env:npm_config_cache = "$probe/npm-build-cache"
Push-Location "$probe/source"
npx --yes npm@11.13.0 ci --no-audit --no-fund
npx --yes npm@11.13.0 run build:python-worker
npx --yes npm@11.13.0 pack --workspaces --pack-destination "$probe/packages"
Pop-Location

$env:npm_config_cache = "$probe/npm-consumer-cache"
Push-Location "$probe/consumer"
Set-Content -Encoding utf8 package.json '{"name":"knowledge-consumer","private":true,"type":"module"}'
$tarballs = Get-ChildItem "$probe/packages/*.tgz" | Select-Object -ExpandProperty FullName
npx --yes npm@11.13.0 install --ignore-scripts --no-audit --no-fund @tarballs
Pop-Location

python -m venv "$probe/venv"
$python = "$probe/venv/Scripts/python.exe"
$example = "$probe/source/examples/modules/manage-knowledge"
$retrieval = "$probe/source/examples/knowledge-evals/zh-retrieval"
& $python -m pip install --no-cache-dir --index-url https://pypi.org/simple -r "$example/requirements.txt" -r "$retrieval/requirements-retrieval.txt"
& $python -m pip wheel --no-cache-dir --no-deps --index-url https://pypi.org/simple --wheel-dir "$probe/packages" "$probe/source/python"
$wheel = Get-ChildItem "$probe/packages/*.whl" | Select-Object -ExpandProperty FullName
& $python -m pip install --no-cache-dir --no-index $wheel

$modelRevision = '2b34e84df040034d4b9eabb62383a87c18955822'
foreach ($file in 'model_quantized.onnx', 'tokenizer.json') {
    curl --fail --location --retry 2 --max-time 450 "https://huggingface.co/gpahal/bge-m3-onnx-int8/resolve/$modelRevision/$file" --output "$probe/model/$file"
}
node "$repo/examples/modules/manage-knowledge/clean-consumer.mjs" "$probe/consumer" $python "$probe/source" "$probe/model"
```

在 Linux 的 PowerShell 中，将 `$python` 改为 `"$probe/venv/bin/python"`。验收脚本使用回环 Provider 夹具，实际执行知识查询并转发引用，无需外部生成模型凭据。两次启动均不指定状态文件，知识服务会逐字节核对模型摘要，再从固定清单的原文重建内存索引。

## 2026-11-23 Windows 实测

Node.js 22.22.1、npm 11.13.0、Python 3.12.13、pip 25.0.1。8 个 npm 包和 Python wheel 均为固定源码本地构建的 `1.4.0`，npm 安装锁记录了全部 8 个本地 tarball 来源。知识服务使用 Qdrant Client 1.15.1、ONNX Runtime 1.23.2 和量化 BGE-M3。模型与分词器 SHA-256 与源码固定值一致。

| 检查 | 耗时 | 退出码 |
| --- | ---: | ---: |
| 空缓存 npm ci、构建并打包 | 122.44 秒 / 68.82 秒 / 31.06 秒 | 0 / 0 / 0 |
| npm 消费者首次安装 | 117.62 秒 | 0 |
| 创建 Python venv、安装知识服务依赖 | 17.67 秒 / 264.25 秒 | 0 / 0 |
| 构建 wheel、Python 消费者首次安装 | 47.15 秒 / 1.83 秒 | 0 / 0 |
| 下载 ONNX 模型、分词器 | 224.33 秒 / 66.66 秒 | 0 / 0 |
| 两次索引启动和四入口检索 | 54.40 秒 | 0 |

每次从 5 个来源版本的 56 个文本块重建索引，服务分别在 10.27 秒和 6.12 秒就绪。8 次查询全部退出 `0`，均返回《资料室手册》二版第 5 行和原句「普通咨询从资料室的“读者来信”栏提交。」

首跑使用 Windows `tar.exe` 解包，中文文件名错误导致语料导入报 `WinError 2`（16.10 秒，退出 `1`）。改用按 UTF-8 读取同一归档的 Python 解包。后续两次夹具调试遇到启动日志控制字符和固定工具名匹配问题（120.53 秒、13.75 秒，均退出 `1`）。验收脚本现已处理控制字符并使用 Provider 实际收到的工具名。

## 候选制品回装

发布 CoreMind 2.0.0 前，在新建消费者目录中安装候选 tarball 与 wheel，使用同一固定数据集、模型和验收脚本复跑。保留 npm 与 Python 的制品来源、版本、SHA-256、耗时、退出码和两次索引的查询结果。
