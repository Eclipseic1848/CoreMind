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

MCP_LICENSE_SOURCES = (
    ("@modelcontextprotocol/client", "LICENSE", "modelcontextprotocol-LICENSE"),
    ("@modelcontextprotocol/core", "LICENSE", "modelcontextprotocol-LICENSE"),
    ("eventsource", "LICENSE", "eventsource-LICENSE"),
    ("eventsource-parser", "LICENSE", "eventsource-parser-LICENSE"),
    ("jose", "LICENSE.md", "jose-LICENSE.md"),
    ("pkce-challenge", "LICENSE", "pkce-challenge-LICENSE"),
    ("undici", "LICENSE", "undici-LICENSE"),
    ("zod", "LICENSE", "zod-LICENSE"),
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
        blockers.extend(check_bundled_worker_identity(archive))
        blockers.extend(check_linux_sandbox_assets(archive))
        blockers.extend(check_mcp_license_assets(archive))
        blockers.extend(check_windows_mcp_assets(archive))
        blockers.extend(check_skill_assets(
            archive, Path(__file__).resolve().parents[1] / "packages" / "coremind-templates" / "skills"
        ))
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


RUNTIME_DEPENDENCY_NAMES = (
    "@earendil-works/pi-agent-core", "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent", "@earendil-works/pi-codemode",
    "@earendil-works/pi-mcp", "@earendil-works/pi-telemetry", "@earendil-works/pi-tui",
)


def check_bundled_worker_identity(archive: zipfile.ZipFile, repository_root: Path | None = None) -> list[str]:
    root = (repository_root or Path(__file__).resolve().parents[1]).resolve()
    prefix = "coremind/_worker/"
    source = root / "python" / "src" / "coremind" / "_worker"
    contents: dict[str, bytes] = {}
    try:
        for filename in ("manifest.json", "coremind-worker.mjs"):
            if archive.namelist().count(prefix + filename) != 1:
                return ["内置 Worker 身份文件缺失或重复"]
            contents[filename] = archive.read(prefix + filename)
            # 固定提交中的生成物是发布来源，不能只信 wheel 自带的自洽摘要。
            if contents[filename] != (source / filename).read_bytes():
                return [f"内置 Worker 与冻结源码不一致：{filename}"]
        manifest = json.loads(contents["manifest.json"].decode("utf-8"))
        lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    except (KeyError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ["内置 Worker 缺少有效的冻结来源"]
    if not isinstance(manifest, dict) or manifest.get("bundleSha256") != hashlib.sha256(contents["coremind-worker.mjs"]).hexdigest():
        return ["内置 Worker 内容摘要不匹配"]
    dependencies = manifest.get("runtimeDependencies")
    if not isinstance(dependencies, dict) or set(dependencies) != set(RUNTIME_DEPENDENCY_NAMES):
        return ["内置 Worker 核心依赖身份不完整"]
    versions: set[str] = set()
    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, dict):
        return ["内置 Worker 缺少锁定安装来源"]
    for name, identity in dependencies.items():
        if (not isinstance(identity, dict) or set(identity) != {"version", "integrity", "bundled"}
                or not isinstance(identity["version"], str)
                or not isinstance(identity["integrity"], str)
                or not identity["integrity"].startswith("sha512-")
                or type(identity["bundled"]) is not bool):
            return [f"内置 Worker 核心依赖身份格式无效：{name}"]
        versions.add(identity["version"])
        suffix = "node_modules/" + name
        entries = [(relative, value) for relative, value in packages.items()
                   if relative == suffix or relative.endswith("/" + suffix)]
        if not entries:
            return [f"内置 Worker 核心依赖未锁定：{name}"]
        for relative, locked in entries:
            try:
                filename = (root / relative / "package.json").resolve()
                if not filename.is_relative_to(root):
                    return ["核心依赖安装路径超出冻结目录"]
                metadata = json.loads(filename.read_text(encoding="utf-8"))
                if (not isinstance(locked, dict) or not isinstance(metadata, dict)
                        or metadata.get("name") != name
                        or metadata.get("version") != identity["version"]
                        or locked.get("version") != identity["version"]
                        or locked.get("integrity") != identity["integrity"]):
                    return [f"内置 Worker 核心依赖与实际 metadata/lock 不一致：{name}"]
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                return [f"内置 Worker 核心依赖安装来源不可读：{name}"]
    if len(versions) != 1 or not any(value["bundled"] for value in dependencies.values()):
        return ["内置 Worker 核心依赖版本不一致或未记录真实内联来源"]
    return []


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


def check_windows_mcp_assets(archive: zipfile.ZipFile) -> list[str]:
    prefix = "coremind/_worker/vendor/windows-mcp/"
    vendor = Path(__file__).resolve().parents[1] / "packages/coremind-tools/src/vendor/windows-mcp"
    expected_names = {"service.mjs", "manifest.json", "metafile.json", "THIRD-PARTY-LICENSES.txt"}
    blockers: list[str] = []
    # 逐字节核对同一冻结源码的资产，拒绝把同步伪造的 manifest 当可信身份。
    for relative in sorted(expected_names):
        if archive.namelist().count(prefix + relative) > 1:
            blockers.append(f"Windows MCP 启动器存在重复资产：{relative}")
        try:
            content = archive.read(prefix + relative)
        except KeyError:
            blockers.append(f"Windows MCP 启动器缺少资产：{relative}")
            continue
        if content != (vendor / relative).read_bytes():
            blockers.append(f"Windows MCP 启动器资产与冻结源码不一致：{relative}")
    unexpected = {name.removeprefix(prefix) for name in archive.namelist() if name.startswith(prefix)} - expected_names
    if unexpected:
        blockers.append("Windows MCP 启动器包含未审查资产")
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


def check_mcp_license_assets(archive: zipfile.ZipFile, source_root: Path | None = None) -> list[str]:
    prefix = "coremind/_worker/vendor/mcp/"
    repository_root = Path(__file__).resolve().parents[1]
    source_root = source_root if source_root is not None else repository_root / "node_modules"
    try:
        manifest = json.loads(archive.read(prefix + "manifest.json").decode("utf-8"))
        lock = json.loads((repository_root / "package-lock.json").read_text(encoding="utf-8"))
    except (KeyError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ["MCP 许可缺少有效 manifest 或锁定来源"]
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int:
        return ["MCP 许可 manifest 格式无效"]

    sources: dict[str, object] = {}
    artifacts: dict[str, str] = {}
    for name, license_file, license_artifact in MCP_LICENSE_SOURCES:
        directory = source_root.joinpath(*name.split("/"))
        try:
            metadata = json.loads((directory / "package.json").read_text(encoding="utf-8"))
            locked = lock["packages"]["node_modules/" + name]
            if (
                not isinstance(metadata, dict)
                or not isinstance(locked, dict)
                or metadata.get("name") != name
                or metadata.get("version") != locked.get("version")
                or metadata.get("license") != locked.get("license")
                or not isinstance(locked.get("integrity"), str)
            ):
                return [f"MCP 许可本地来源身份与 lock 不一致：{name}"]
            files: dict[str, object] = {}
            for filename in (license_file, "NOTICE"):
                source = directory / filename
                if filename == "NOTICE" and not source.exists():
                    continue
                artifact = license_artifact if filename == license_file else name.replace("@", "").replace("/", "-") + "-NOTICE"
                sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
                if artifact in artifacts and artifacts[artifact] != sha256:
                    return ["共用 MCP 许可的来源原文不一致"]
                artifacts[artifact] = sha256
                files[filename] = {"artifact": artifact, "sha256": sha256}
            sources[name] = {
                "version": metadata["version"],
                "license": metadata["license"],
                "integrity": locked["integrity"],
                "files": files,
            }
        except (KeyError, OSError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            return [f"MCP 许可缺少有效的本地锁定来源：{name}"]
    if manifest != {"schemaVersion": 1, "sources": sources, "artifacts": artifacts}:
        return ["MCP 许可 manifest 与本地锁定来源及原文摘要不一致"]

    packed = [name for name in archive.namelist() if name.startswith(prefix) and not name.endswith("/")]
    expected = {prefix + name for name in artifacts} | {prefix + "manifest.json"}
    blockers: list[str] = []
    if set(packed) != expected:
        blockers.append("MCP 许可资产缺失或包含未知文件")
    for name in sorted(set(packed)):
        if packed.count(name) != 1:
            blockers.append(f"MCP 许可包含重复资产：{name}")
        relative = name.removeprefix(prefix)
        if relative in artifacts and hashlib.sha256(archive.read(name)).hexdigest() != artifacts[relative]:
            blockers.append(f"MCP 许可资产与来源摘要不匹配：{relative}")
    return blockers


def check_skill_assets(archive: zipfile.ZipFile, source_root: Path) -> list[str]:
    if not source_root.is_dir():
        return ["缺少技能资源源目录"]
    expected = {
        "coremind/skills/" + source.relative_to(source_root).as_posix(): source.read_bytes()
        for source in sorted(source_root.glob("*/*"))
        if source.is_file() and source.name in {"README.md", "SKILL.md"}
    }
    if not expected:
        return ["技能资源源目录为空"]
    packed = [name for name in archive.namelist() if name.startswith("coremind/skills/") and not name.endswith("/")]
    blockers: list[str] = []
    for name in sorted(set(expected) - set(packed)):
        blockers.append(f"wheel 缺少技能资源：{name}")
    for name in sorted(set(packed) - set(expected)):
        blockers.append(f"wheel 包含来源不明的技能资源：{name}")
    for name in sorted(set(packed)):
        if packed.count(name) != 1:
            blockers.append(f"wheel 包含重复技能资源：{name}")
        if name in expected and hashlib.sha256(archive.read(name)).digest() != hashlib.sha256(expected[name]).digest():
            blockers.append(f"wheel 技能资源摘要不匹配：{name}")
    return blockers


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
import sys
import tempfile
from pathlib import Path
from importlib.metadata import version
import coremind
from coremind import ERROR_CODES, CoreMindClient, __version__

assert Path(coremind.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
assert __version__ == version("coremind-ai"), (__version__, version("coremind-ai"))
assert ERROR_CODES["unclassified_error"]["humanAction"] == "required"
os.environ.pop("COREMIND_WORKER_PATH", None)
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
                [str(python), "-I", "-X", "utf8", "-c", program],
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
            skill_smoke = run(
                [str(python), "-I", "-X", "utf8", str(repository_root / "scripts" / "wheel-skill-smoke.py")],
                "wheel 外部标准技能冒烟失败",
            )
            if json.loads(skill_smoke.stdout.strip().splitlines()[-1]).get("skillLoaded") is not True:
                raise SystemExit("wheel 外部标准技能未成功加载")
            print("wheel 外部标准技能、冻结正文与重复引用冒烟通过")
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
