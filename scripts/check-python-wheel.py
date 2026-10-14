from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path


MIT_LICENSE_NOTICE = '''MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.'''

WORKSTATION_PATH = re.compile(
    r"(?i:[A-Za-z]:[\\/](?:Users|home|new branch)[\\/])"
    r"|(?<![A-Za-z0-9_])/(?:home|Users)/[^/\s]+/"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 CoreMind Python wheel 发布内容")
    parser.add_argument("wheel", nargs="?", type=Path)
    args = parser.parse_args()
    wheel = resolve_wheel(args.wheel)
    if not wheel.is_file() or wheel.suffix != ".whl":
        raise SystemExit(f"wheel 不存在：{wheel}")

    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        metadata_name = next((name for name in names if name.endswith(".dist-info/METADATA")), None)
        worker_name = "coremind/_worker/coremind-worker.mjs"
        error_contract_name = "coremind/_error_contract.json"
        blockers: list[str] = []
        if metadata_name is None:
            blockers.append("缺少 METADATA")
        else:
            metadata = archive.read(metadata_name).decode("utf-8", errors="strict")
            if "License-Expression: MIT" not in metadata:
                blockers.append("METADATA 缺少 MIT License-Expression")
            if "Classifier: Development Status :: 5 - Production/Stable" not in metadata:
                blockers.append("METADATA 缺少 Production/Stable classifier")
        if worker_name not in names:
            blockers.append("缺少内置 Node worker")
        else:
            blockers.extend(check_worker_bundle(archive.read(worker_name).decode("utf-8")))
        blockers.extend(check_linux_sandbox_assets(archive))
        if error_contract_name not in names:
            blockers.append("缺少 Python Error Contract")
        else:
            error_contract = json.loads(archive.read(error_contract_name).decode("utf-8"))
            unclassified = error_contract.get("codes", {}).get("unclassified_error", {})
            if error_contract.get("schemaVersion") != 1 or unclassified.get("humanAction") != "required":
                blockers.append("Python Error Contract 无效")
        forbidden_entry = re.compile(r"(^|/)(__pycache__|tests?|\.git|\.env)(/|$)|\.pyc$", re.I)
        bad_entries = [name for name in names if forbidden_entry.search(name)]
        if bad_entries:
            blockers.append(f"包含不应发布的文件：{', '.join(bad_entries)}")

        for name in names:
            if name.endswith((".md", ".mjs", ".py", "METADATA")):
                text = archive.read(name).decode("utf-8", errors="strict")
                if WORKSTATION_PATH.search(text):
                    blockers.append(f"{name} 包含本机绝对路径")

    if blockers:
        raise SystemExit("wheel 预检失败：\n- " + "\n- ".join(blockers))
    print(f"wheel 预检通过：{wheel.name}，{len(names)} 个条目")
    smoke_install(wheel)
    return 0


def check_worker_bundle(bundle: str) -> list[str]:
    blockers: list[str] = []
    if " ".join(MIT_LICENSE_NOTICE.split()) not in " ".join(bundle.split()):
        blockers.append("内置 Worker 缺少必要的完整版权许可")
    removed_backend = re.compile(
        r"node_modules[\\/](?:node-forge[\\/]|@anthropic-ai[\\/]sandbox-runtime[\\/]dist[\\/]sandbox[\\/]"
        r"(?:mitm-(?:ca|leaf)|(?:tls-terminate|http|socks|parent|mux)-proxy)\.js)",
        re.I,
    )
    if removed_backend.search(bundle):
        blockers.append("内置 Worker 仍包含已移除的加密或流量拦截后端")
    return blockers


def check_linux_sandbox_assets(archive: zipfile.ZipFile) -> list[str]:
    prefix = "coremind/_worker/vendor/linux-sandbox/"
    names = set(archive.namelist())
    try:
        manifest = json.loads(archive.read(prefix + "manifest.json").decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError):
        return ["Linux 安全后端缺少有效 manifest.json"]

    artifacts = {"backend.mjs", "LICENSE", "metafile.json", "bin/x64/apply-seccomp", "bin/arm64/apply-seccomp"}
    if (
        not isinstance(manifest, dict)
        or type(manifest.get("schemaVersion")) is not int
        or manifest["schemaVersion"] != 1
    ):
        return ["Linux 安全后端 manifest 格式无效"]
    source = manifest.get("source")
    build = manifest.get("build")
    hashes = manifest.get("artifacts")
    if (
        not isinstance(source, dict)
        or not all(isinstance(source.get(key), str) and source[key] for key in ("package", "version", "license"))
        or not isinstance(source.get("files"), dict)
        or not source["files"]
        or not all(isinstance(key, str) and key and valid_sha256(value) for key, value in source["files"].items())
        or not isinstance(build, dict)
        or not all(isinstance(build.get(key), str) and build[key] for key in ("esbuild", "entry"))
        or build.get("network") != "denied"
        or build.get("proxies") is not False
        or not isinstance(hashes, dict)
        or set(hashes) != artifacts
        or not all(valid_sha256(value) for value in hashes.values())
    ):
        return ["Linux 安全后端 manifest 来源、构建边界或资产摘要格式无效"]

    blockers: list[str] = []
    if prefix + "backend.d.mts" not in names:
        blockers.append("Linux 安全后端缺少 backend.d.mts")
    for relative in sorted(artifacts):
        name = prefix + relative
        if name not in names:
            blockers.append(f"Linux 安全后端缺少资产：{relative}")
            continue
        content = archive.read(name)
        if hashlib.sha256(content).hexdigest() != hashes[relative]:
            blockers.append(f"Linux 安全后端资产摘要不匹配：{relative}")
        if relative.startswith("bin/"):
            machine = 62 if relative == "bin/x64/apply-seccomp" else 183
            if (
                len(content) < 64
                or content[:6] != b"\x7fELF\x02\x01"
                or int.from_bytes(content[18:20], "little") != machine
            ):
                blockers.append(f"Linux 安全后端 helper 架构无效：{relative}")
    return blockers


def valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def resolve_wheel(argument: Path | None) -> Path:
    if argument is not None:
        return argument.resolve()
    repository_root = Path(__file__).resolve().parents[1]
    pyproject = (repository_root / "python" / "pyproject.toml").read_text(encoding="utf-8")
    version_match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    if version_match is None:
        raise SystemExit("无法从 python/pyproject.toml 读取版本")
    prefix = f"coremind_ai-{version_match.group(1)}-"
    wheels = sorted(
        path
        for path in (repository_root / "python" / "dist").glob("*.whl")
        if path.name.startswith(prefix)
    )
    if len(wheels) != 1:
        names = "、".join(path.name for path in wheels) or "无"
        raise SystemExit(f"python/dist 必须恰好包含一个当前版本 wheel，当前为：{names}")
    return wheels[0].resolve()


def smoke_install(wheel: Path) -> None:
    if shutil.which("node") is None:
        raise SystemExit("wheel 冒烟需要 PATH 中存在 Node.js")
    skip_child_run = os.environ.get("COREMIND_SKIP_RELEASE_CHILD_RUN_SMOKE") == "true"
    with tempfile.TemporaryDirectory(prefix="coremind-wheel-smoke-") as temporary:
        root = Path(temporary)
        environment = root / "venv"
        run([sys.executable, "-m", "venv", str(environment)], "创建干净虚拟环境失败")
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-deps",
                "--no-index",
                str(wheel),
            ],
            "在干净虚拟环境安装 wheel 失败",
        )
        port = free_port()
        repository_root = Path(__file__).resolve().parents[1]
        server = subprocess.Popen(
            [
                "node",
                str(repository_root / "packages" / "coremind-cli" / "test" / "mock-delegation-server.mjs"),
                str(port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            wait_for_port(port)
            program = f"""
import json
import os
import tempfile
from importlib.metadata import version
from coremind import ERROR_CODES, CoreMindClient, __version__

assert __version__ == version("coremind-ai"), (__version__, version("coremind-ai"))
assert ERROR_CODES["unclassified_error"]["humanAction"] == "required"
os.environ["COREMIND_WHEEL_SMOKE_API_KEY"] = "test-key"
config = {{
    "schemaVersion": 2,
    "name": "wheel-smoke",
    "provider": {{
        "id": "probe",
        "baseUrl": "http://127.0.0.1:{port}/v1",
        "model": "probe-model",
        "apiKeyEnv": "COREMIND_WHEEL_SMOKE_API_KEY",
    }},
    "agents": {{
        "main": {{
            "systemPrompt": "离线安装冒烟",
            "delegation": {{
                "budget": {{"tokens": 1000, "toolCalls": 2, "costUsd": 1, "wallTimeMs": 5000, "steps": 2, "descendants": 1}},
                "targets": {{"researcher": {{"budget": {{"tokens": 1000, "toolCalls": 2, "costUsd": 1, "wallTimeMs": 5000, "steps": 2, "descendants": 0}}}}}},
            }},
        }},
        "researcher": {{"systemPrompt": "你是研究 Agent。"}},
    }},
    "defaultAgent": "main",
    "runtime": {{"maxSteps": 4, "maxToolCalls": 4, "maxTokens": 2000, "maxCostUsd": 2, "runTimeoutMs": 30000}},
    "permissions": {{"mode": "full", "workspaceOnly": True, "network": "allow"}},
}}
with tempfile.TemporaryDirectory(prefix="coremind-wheel-runtime-") as directory:
    result = None
    with CoreMindClient(config, config_dir=directory, cwd=directory, request_timeout=30) as client:
        assert client.pid is not None
        if not {skip_child_run!r}:
            result = client.run("完成父任务")
if result is not None:
    node = result["childRuns"]["nodes"][0]
    assert node["agentName"] == "researcher", node
    assert node["status"] == "joined", node
    assert node["outcome"]["status"] == "succeeded", node
print(json.dumps({{"version": __version__, "workerStarted": True, "childRun": result is not None}}))
"""
            completed = run(
                [str(python), "-X", "utf8", "-c", program],
                "wheel 导入、内置 Worker 或 Child Run 冒烟失败",
            )
            payload = json.loads(completed.stdout.strip().splitlines()[-1])
            if payload.get("workerStarted") is not True or (
                not skip_child_run and payload.get("childRun") is not True
            ):
                raise SystemExit("wheel 内置 Worker 或 Child Run 未成功")
            child_run_status = (
                "已按维护者授权跳过 GitHub Runner Linux sandbox Child Run 冒烟"
                if skip_child_run
                else "Child Run 冒烟通过"
            )
            print(f"wheel 干净安装与内置 Worker 冒烟通过；{child_run_status}：Python {payload['version']}")
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=2)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def wait_for_port(port: int) -> None:
    for _attempt in range(250):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.02)
    raise SystemExit("mock Child Run server 启动超时")


def run(command: list[str], message: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        check=False,
    )
    if completed.returncode != 0:
        detail = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
        raise SystemExit(f"{message}（退出码 {completed.returncode}）\n{detail}")
    return completed


if __name__ == "__main__":
    raise SystemExit(main())
