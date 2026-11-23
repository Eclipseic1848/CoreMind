# Clean consumer installation and knowledge index rebuild

This check covers the P1 follow-up. Build package files from the merged P2-A revision, then install the npm tarballs and Python wheel in isolated consumer environments. The knowledge service builds an in-memory Qdrant index twice from the source documents. On each start, CLI with YAML, the TypeScript SDK, and the synchronous and asynchronous Python SDKs query the same service. All four entry points should cite line 5 of `资料室手册-v2.md`.

## Reproduce in an empty directory

Use Node.js 22.19 or later, Python 3.12, and PowerShell 7.4 or later. Make sure `python` resolves to Python 3.12. Run the commands from the CoreMind repository root. Third-party dependencies come from the public npm and PyPI registries. The embedding files come from a pinned Hugging Face revision.

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

In PowerShell on Linux, set `$python` to `"$probe/venv/bin/python"`. The check uses a loopback model fixture that calls the real knowledge service and returns the resulting citation. The service verifies the model file digests and builds its index from the manifest's source documents. Both starts use an empty in-memory index with no state file.

## Windows results on 2026-11-23

Node.js 22.22.1, npm 11.13.0, Python 3.12.13, and pip 25.0.1. All eight npm packages and the Python wheel were built locally from the pinned source at package version `1.4.0`. The npm lock recorded all eight local tarball sources. The knowledge service used Qdrant Client 1.15.1, ONNX Runtime 1.23.2, and quantized BGE-M3. Both model file digests matched the pinned source values.

| Check                                              |                 Elapsed time | Exit code |
| -------------------------------------------------- | ---------------------------: | --------: |
| Empty-cache npm ci, build, and pack                | 122.44 s / 68.82 s / 31.06 s | 0 / 0 / 0 |
| First npm consumer installation                    |                     117.62 s |         0 |
| Python venv and knowledge service dependencies     |           17.67 s / 264.25 s |     0 / 0 |
| Build and install the consumer wheel               |             47.15 s / 1.83 s |     0 / 0 |
| Download the ONNX model and tokenizer              |           224.33 s / 66.66 s |     0 / 0 |
| Rebuild twice and query from all four entry points |                      54.40 s |         0 |

Each rebuild indexed 56 text chunks from five source revisions. The service was ready in 10.27 s on the first start and 6.12 s on the second. All eight queries exited `0` and cited the same text on line 5 of `资料室手册-v2.md`, revision 2.

The first attempt used Windows `tar.exe`, which decoded the Chinese filenames incorrectly. The import raised `WinError 2` after 16.10 s and exited `1`. Python then extracted the same archive as UTF-8. The next two fixture runs exposed terminal control characters in the service startup log and a fixed tool-name check, taking 120.53 s and 13.75 s and exiting `1`. The check now handles those characters and uses the tool name presented to the Provider.

## Repeat with release candidates

Before publishing CoreMind 2.0.0, install the release candidate tarballs and wheel in fresh consumer environments and rerun the same dataset, model, and check. Record package sources, versions, SHA-256 digests, elapsed times, exit codes, and the results from both index builds.
