"""Python SDK 单元测试使用的最小协议 worker。"""

from __future__ import annotations

import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

pending_run_id: int | None = None


def send(value: object) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def snapshot(run_id: str, outcome: dict[str, str]) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "operation": {"state": "completed"},
        "outcome": outcome,
        "metrics": {},
        "evaluation": {},
        "releaseReadiness": {},
        "trace": [],
        "checkpoints": [],
        "artifacts": [],
        "extensions": [],
        "resumable": False,
    }


for line in sys.stdin:
    request = json.loads(line)
    request_id = request["id"]
    method = request["method"]
    params = request["params"]
    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"protocolVersion": "1.0", "capabilities": ["runSnapshot"]},
            }
        )
    elif method == "register_tool" and params["name"] == "reject_registration":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": "拒绝测试工具",
                    "data": {"coremindCode": "invalid_tool"},
                },
            }
        )
    elif method == "register_tool":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"registered": params["name"]}})
    elif method == "run" and params.get("input") == "坏快照":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": "run-bad",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": {"schemaVersion": 1, "runId": "other-run"},
                },
            }
        )
    elif method == "run" and params.get("input") == "调用工具":
        pending_run_id = request_id
        send(
            {
                "jsonrpc": "2.0",
                "method": "python_tool_call",
                "params": {
                    "protocolVersion": "1.0",
                    "runId": "run-tool",
                    "callId": "call-1",
                    "tool": "lookup_order",
                    "args": {"order_id": "A-1"},
                },
            }
        )
    elif method == "tool_result":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"accepted": True}})
        send(
            {
                "jsonrpc": "2.0",
                "id": pending_run_id,
                "result": {
                    "runId": "run-tool",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": snapshot(
                        "run-tool", {"status": "succeeded", "finishReason": "completed"}
                    ),
                    "transcript": json.dumps(params["result"], ensure_ascii=False, separators=(",", ":")),
                    "outputs": {},
                    "messages": {"main": []},
                },
            }
        )
        pending_run_id = None
    elif method == "run":
        send(
            {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {
                    "protocolVersion": "1.0",
                    "runId": "run-1",
                    "sequence": 1,
                    "timestamp": "2026-08-07T00:00:00.000Z",
                    "event": {"type": "agent_start", "agent": "main"},
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": "run-1",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": snapshot(
                        "run-1", {"status": "succeeded", "finishReason": "completed"}
                    ),
                    "transcript": "完成",
                    "outputs": {},
                    "messages": {"main": []},
                },
            }
        )
    elif method == "inspect_run":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": params["runId"],
                    "status": "finished",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "checkpoints": [{"checkpointId": "checkpoint-1"}],
                    "records": [],
                },
            }
        )
    elif method == "resume_run":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": params["runId"],
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": snapshot(
                        params["runId"],
                        {"status": "succeeded", "finishReason": "completed"},
                    ),
                    "transcript": "已恢复",
                    "outputs": {},
                    "messages": {"main": []},
                },
            }
        )
    elif method == "checkpoint_diff":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "checkpointId": params["checkpointId"],
                    "changed": True,
                    "reversible": True,
                },
            }
        )
    elif method == "checkpoint_restore":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": params["runId"],
                    "checkpointId": params["checkpointId"],
                    "restored": True,
                },
            }
        )
    elif method == "close":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"closed": True}})
        break
    else:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": f"未知方法：{method}",
                    "data": {"coremindCode": "unknown_method"},
                },
            }
        )
