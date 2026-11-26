"""用真实知识 wheel 演练停机备份、恢复和重启。"""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


STATE = Path("state/catalog.json")
EXAMPLE = Path(__file__).resolve().parents[4] / "components/knowledge/example"
HTTP = build_opener(ProxyHandler({}))


@contextmanager
def serve(console, model, project, token, *args):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    command = [
        str(console), "--manifest", "manifest.json", "--state", str(STATE),
        "--model-dir", str(model), "--scope", "records", "--port", str(port), *args,
    ]
    env = dict(os.environ, COREMIND_KNOWLEDGE_AUTHORIZATION=token, PYTHONUTF8="1", PYTHONPATH="")
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as log:
        started = time.monotonic()
        process = subprocess.Popen(
            command, cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
        )
        try:
            while time.monotonic() - started < 90:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    health = Request(url + "/health", headers={"Authorization": token})
                    with HTTP.open(health, timeout=2) as response:
                        assert json.load(response)["status"] == "ready"
                    break
                except HTTPError:
                    raise
                except (URLError, TimeoutError):
                    time.sleep(0.2)
            else:
                raise TimeoutError("等待知识服务启动超时")
            yield url, round(time.monotonic() - started, 3)
        finally:
            if process.poll() is None and os.name == "nt":
                # Windows 的 wheel 入口使用独立 Python 子进程。
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    check=True, capture_output=True, timeout=15,
                )
            elif process.poll() is None:
                process.terminate()
            process.wait(timeout=15)


def call(url, token, name, **arguments):
    body = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    headers = {
        "Authorization": token, "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    request = Request(url + "/mcp", json.dumps(body).encode("utf-8"), headers)
    with HTTP.open(request, timeout=20) as response:
        result = json.load(response)["result"]
    assert not result.get("isError"), result
    return json.loads(result["content"][0]["text"])


def verify_citations(url, token):
    try:
        with HTTP.open(url + "/health", timeout=2):
            raise AssertionError("未认证请求未被拒绝")
    except HTTPError as error:
        assert error.code == 401
    started = time.monotonic()
    hits = call(url, token, "search_knowledge", query="松纹卡")["citations"]
    query_ms = round((time.monotonic() - started) * 1000, 1)
    hit = next(row for row in hits if row["docId"] == "desk" and "银杏台" in row["text"])
    assert (hit["version"], hit["file"], hit["line"]) == (1, "desk.md", 3)
    resolved = call(
        url, token, "resolve_citation", docId="desk", version=1, file="desk.md", line=3,
    )
    assert resolved["status"] == "available" and resolved["text"] == hit["text"]
    assert resolved["tableHeader"] == [{"line": 1, "text": "| 物件 | 办理窗口 |"}]
    assert all(
        row["docId"] != "obsolete"
        for row in call(url, token, "search_knowledge", query="檀木牌")["citations"]
    )
    withdrawn = call(
        url, token, "resolve_citation", docId="obsolete", version=1, file="obsolete.md", line=1,
    )
    assert withdrawn["status"] == "withdrawn" and "text" not in withdrawn
    return resolved, withdrawn, query_ms


def file_hashes(project):
    return {
        str(file.relative_to(project)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in project.rglob("*") if file.is_file()
    }


def run(console, model):
    token = "Bearer " + secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix="coremind-knowledge-recovery-") as temporary:
        root = Path(temporary)
        project = root / "business"
        shutil.copytree(EXAMPLE, project)
        manifest = project / "manifest.json"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["documents"].append(dict(payload["documents"][0], id="obsolete", file="obsolete.md"))
        manifest.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        (project / "sources/obsolete.md").write_text("旧版编号为檀木牌。", encoding="utf-8")

        with serve(console, model, project, token, "--withdraw", "obsolete:1") as (url, startup):
            current, withdrawn, query_ms = verify_citations(url, token)
        hashes = file_hashes(project)
        with serve(console, model, project, token) as (url, restart):
            assert verify_citations(url, token)[:2] == (current, withdrawn)
        assert file_hashes(project) == hashes

        snapshot = root / "snapshot"
        restored = root / "restored"
        started = time.monotonic()
        shutil.copytree(project, snapshot)
        backup_seconds = round(time.monotonic() - started, 3)
        assert file_hashes(snapshot) == hashes
        project.rename(root / "business-offline")
        started = time.monotonic()
        shutil.copytree(snapshot, restored)
        restore_seconds = round(time.monotonic() - started, 3)
        with serve(console, model, restored, token) as (url, restored_startup):
            assert verify_citations(url, token)[:2] == (current, withdrawn)
        assert file_hashes(restored) == hashes

        return {
            "version": subprocess.check_output(
                [str(console), "--version"], encoding="utf-8", timeout=15,
            ).strip(),
            "startupSeconds": startup,
            "restartSeconds": restart,
            "restoredStartupSeconds": restored_startup,
            "firstQueryMilliseconds": query_ms,
            "backupSeconds": backup_seconds,
            "restoreSeconds": restore_seconds,
            "backupBytes": sum(file.stat().st_size for file in snapshot.rglob("*") if file.is_file()),
            "catalogBytes": (snapshot / STATE).stat().st_size,
            "catalogSha256": hashes[str(STATE)],
            "modelBytes": sum((model / name).stat().st_size for name in ("model_quantized.onnx", "tokenizer.json")),
            "citation": "available",
            "withdrawal": "withdrawn",
            "anonymousHealth": 401,
            "restoredFilesUnchanged": True,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--console", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.console.resolve(strict=True), args.model_dir.resolve(strict=True)), ensure_ascii=False))
