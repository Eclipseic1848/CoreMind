"""从业务目录使用已安装的 wheel 与正式 2.0.0 源码，核对迁移和回滚。"""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def check(console, model, project, archive, root, *, persistent=False):
    legacy = root / "legacy"
    with zipfile.ZipFile(archive) as source:
        for relative in ("modules/manage-knowledge/knowledge_server.py", "modules/manage-knowledge/knowledge_catalog.py",
                         "knowledge-evals/zh-retrieval/keyword_baseline.py", "knowledge-evals/zh-retrieval/qdrant_retrieval.py"):
            path = legacy / "examples" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(source.read(f"coremind-2.0.0-source/examples/{relative}"))
    business = root / "business"
    shutil.copytree(project, business)
    manifest = business / "manifest.json"
    sources = business / "sources"
    state = root / "catalog.json"
    original = json.loads(manifest.read_text(encoding="utf-8"))
    row = original["documents"][0]
    old = dict(row, id="obsolete", file="withdrawn.md")
    original["documents"].append(old)
    (sources / old["file"]).write_text("撤回的编号檀木牌。\n", encoding="utf-8")
    manifest.write_text(json.dumps(original), encoding="utf-8")
    source_cmd = [sys.executable, "-B", "-X", "utf8", str(legacy / "examples/modules/manage-knowledge/knowledge_server.py")]
    installed = [str(console)]
    if persistent:
        installed += ["--index-dir", str(root / "qdrant-index")]
    token = "Bearer " + secrets.token_urlsafe(32)
    env = dict(os.environ, COREMIND_KNOWLEDGE_AUTHORIZATION=token, PYTHONPATH="", PYTHONUTF8="1")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    url = f"http://127.0.0.1:{port}"

    def command(entry, scope, extra):
        return [*entry, "--manifest", str(manifest), "--model-dir", str(model), "--scope", scope,
                "--state", str(state), "--port", str(port), *extra]

    @contextmanager
    def serve(entry, scope="records", extra=()):
        with (root / "server.log").open("w+", encoding="utf-8") as log:
            p = subprocess.Popen(command(entry, scope, extra), env=env, cwd=business, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    if p.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with urlopen(Request(url + "/health", headers={"Authorization": token}), timeout=2) as response:
                            assert json.load(response)["status"] == "ready"
                            break
                    except URLError:
                        time.sleep(0.25)
                else:
                    raise TimeoutError("等待本地知识服务启动超时")
                yield
            finally:
                if p.poll() is None and os.name == "nt":
                    # Windows 的 wheel 控制台启动器另起 Python 子进程。
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], check=True, capture_output=True)
                elif p.poll() is None:
                    p.terminate()
                p.wait(timeout=15)

    def rpc(method, params):
        headers = {"Authorization": token, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
        with urlopen(Request(url + "/mcp", data=body, headers=headers), timeout=30) as response:
            return json.load(response)["result"]

    def call(name, **args):
        result = rpc("tools/call", {"name": name, "arguments": args})
        assert not result.get("isError"), result
        return json.loads(result["content"][0]["text"])

    def resolve(doc, line):
        return call("resolve_citation", docId=doc["id"], version=doc["version"], file=doc["file"], line=line)

    with serve(source_cmd, extra=["--withdraw", "obsolete:1"]):
        before = resolve(row, 3)
        tombstone = resolve(old, 1)
        assert before["status"] == "available" and tombstone["status"] == "withdrawn"
    backup = state.read_bytes()
    legacy.rename(root / "source-offline")
    with serve(installed):
        assert resolve(row, 3) == before and resolve(old, 1) == tombstone
        tools = rpc("tools/list", {})["tools"]
        assert {tool["name"] for tool in tools} == {"search_knowledge", "resolve_citation"}
        try:
            urlopen(url + "/health")
        except HTTPError as error:
            assert error.code == 401
        else:
            raise AssertionError("缺少令牌的请求未被拒绝")
        sample = subprocess.run([sys.executable, "-I", "-X", "utf8", str(business / "query.py"), "松纹卡"],
                                cwd=business, env=dict(env, KNOWLEDGE_MCP_URL=url + "/mcp"),
                                capture_output=True, encoding="utf-8")
        assert sample.returncode == 0, sample.stderr
        assert any(json.loads(line) == before for line in sample.stdout.splitlines())
        assert before["tableHeader"] == [{"line": 1, "text": "| 物件 | 办理窗口 |"}]
    assert state.read_bytes() == backup
    with serve(installed, "visitor"):
        assert call("search_knowledge", query="松纹卡")["citations"] == []
        assert resolve(row, 3)["status"] == resolve(old, 1)["status"] == "unknown"
    new = dict(row, version=2, file="desk-v2.md")
    original["documents"].append(new)
    manifest.write_text(json.dumps(original), encoding="utf-8")
    (sources / new["file"]).write_text((sources / row["file"]).read_text(encoding="utf-8").replace("银杏台", "榆木台"), encoding="utf-8")
    failed = subprocess.run(command(installed, "records", ["--withdraw", "desk:1", "--withdraw", "unknown:1"]),
                            cwd=business, env=env, capture_output=True, encoding="utf-8", timeout=90)
    assert failed.returncode and "未知的文档版本" in failed.stderr and state.read_bytes() == backup
    with serve(installed, extra=["--withdraw", "desk:1"]):
        matches = call("search_knowledge", query="松纹卡")["citations"]
        assert any(c["line"] == 3 and "榆木台" in c["text"] for c in matches)
        assert all(c["version"] == 2 and c["docId"] == "desk" for c in matches)
        assert resolve(row, 3)["status"] == "withdrawn" and resolve(old, 1) == tombstone
        current = resolve(new, 3)
    committed = state.read_bytes()
    for bad_state in [manifest, sources / "desk.md", model / "tokenizer.json"]:
        failure = subprocess.run(command(installed, "records", ["--state", str(bad_state)]),
                                 cwd=business, env=env, capture_output=True, encoding="utf-8", timeout=30)
        assert failure.returncode and "--state 必须" in failure.stderr
    bad = dict(new, version=3, file="oversize.md")
    original["documents"].append(bad)
    manifest.write_text(json.dumps(original), encoding="utf-8")
    (sources / bad["file"]).write_text("说明 " * 513, encoding="utf-8")
    failed = subprocess.run(command(installed, "records", []), cwd=business, env=env,
                            capture_output=True, encoding="utf-8", timeout=90)
    assert failed.returncode and "512" in failed.stderr and state.read_bytes() == committed
    (root / "source-offline").rename(legacy)
    original["documents"].pop()
    manifest.write_text(json.dumps(original), encoding="utf-8")
    with serve(source_cmd):
        assert resolve(new, 3) == current and resolve(old, 1) == tombstone and resolve(row, 3)["status"] == "withdrawn"
    assert state.read_bytes() == committed
    print(json.dumps({"version": subprocess.check_output([str(console), "--version"], text=True).strip(),
                      "persistentIndex": persistent,
                      "originalStateSha256": hashlib.sha256(backup).hexdigest(),
                      "rollbackStateSha256": hashlib.sha256(committed).hexdigest(), "dataLine": current["line"],
                      "tableHeaderLine": current["tableHeader"][0]["line"], "withdrawalsAfterRollback": 2,
                      "crossScope": "unknown", "unauthenticated": 401}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("console", "model-dir", "example", "legacy-archive"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--persistent", action="store_true", help="在已安装服务上启用持久索引并验证旧服务回退")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temporary:
        check(args.console.resolve(), args.model_dir.resolve(), args.example.resolve(), args.legacy_archive.resolve(),
              Path(temporary), persistent=args.persistent)
