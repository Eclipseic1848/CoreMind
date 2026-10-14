from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import coremind
from coremind import CoreMindClient


def main() -> None:
    package = Path(coremind.__file__).resolve().parent
    assert package.is_relative_to(Path(sys.prefix).resolve()), "必须使用已回装 wheel 的 Python 包"
    os.environ.pop("COREMIND_WORKER_PATH", None)
    os.environ["COREMIND_SKILL_SMOKE_KEY"] = "offline-test-only"
    skill_id = "wheel-skill"
    name = "安装后标准技能"
    description = "外部配置目录技能冒烟"
    body = "wheel 中的真实 Worker 必须加载此冻结正文：中文🙂。\n"
    sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
    frontmatter = f"---\nname: {name}\ndescription: {description}\n---\n"
    requests: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="coremind-wheel-skill-") as temporary:
        root = Path(temporary)
        config_dir, cwd = root / "configuration", root / "workspace"
        for directory in (config_dir, cwd):
            (directory / "skills" / skill_id).mkdir(parents=True)
        source = config_dir / "skills" / skill_id / "SKILL.md"
        source.write_bytes((frontmatter + body).encode("utf-8"))
        (cwd / "skills" / skill_id / "SKILL.md").write_bytes(
            (frontmatter + "错误的工作目录技能正文\n").encode("utf-8")
        )

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                ordinal = len(requests)
                if ordinal == 1:
                    source.write_bytes((frontmatter + "加载前已经改写的正文\n").encode("utf-8"))
                if ordinal <= 2:
                    delta = {"role": "assistant", "tool_calls": [{
                        "index": 0, "id": f"skill-call-{ordinal}", "type": "function",
                        "function": {"name": "load_skill", "arguments": json.dumps({"id": skill_id})},
                    }]}
                    reason = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "技能冒烟完成"}
                    reason = "stop"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for value, finish in ((delta, None), ({}, reason)):
                    chunk = {"id": f"skill-{ordinal}", "choices": [{
                        "index": 0, "delta": value, "finish_reason": finish,
                    }]}
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            config = {
                "schemaVersion": 2,
                "name": "安装后技能冒烟",
                "provider": {
                    "id": "skill-smoke", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                    "model": "skill-smoke-model", "apiKeyEnv": "COREMIND_SKILL_SMOKE_KEY",
                },
                "agents": {"main": {"systemPrompt": "使用已授权技能", "skills": [skill_id]}},
                "permissions": {"mode": "ask", "allow": ["load_skill"], "workspaceOnly": True, "network": "deny"},
                "runtime": {"maxTurns": 4, "maxRetries": 0, "runTimeoutMs": 20_000},
            }
            with CoreMindClient(config, config_dir=config_dir, cwd=cwd, request_timeout=25) as client:
                result = client.run("加载已配置技能，再次加载并复用正文")
                assert result["outcome"]["status"] == "succeeded", result["outcome"]
                assert client._process is not None
                assert Path(client._process.args[1]).resolve() == package / "_worker" / "coremind-worker.mjs"
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)

    assert len(requests) == 3, len(requests)
    first_text = "\n".join(message_text(message) for message in requests[0]["messages"])
    for value in (skill_id, name, description, sha256):
        assert value in first_text, value
    assert body not in first_text
    assert [tool["function"]["name"] for tool in requests[0]["tools"]] == ["load_skill"]
    rendered_body = f"# 技能 {skill_id} · {name}\n正文 SHA-256: {sha256}\n\n{body}"
    reference = f"技能 {skill_id} 已在当前上下文中（SHA-256: {sha256}），请复用已加载正文。"
    assert tool_results(requests[1]) == [rendered_body], tool_results(requests[1])
    assert tool_results(requests[2]) == [rendered_body, reference], tool_results(requests[2])
    for request in requests:
        text = "\n".join(message_text(message) for message in request["messages"])
        assert "错误的工作目录技能正文" not in text
        assert "加载前已经改写的正文" not in text
    print(json.dumps({"skillLoaded": True, "bodySha256": sha256}))


def message_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in content if part.get("type") == "text")


def tool_results(request: dict) -> list[str]:
    return [message_text(message) for message in request["messages"] if message["role"] == "tool"]


if __name__ == "__main__":
    main()
