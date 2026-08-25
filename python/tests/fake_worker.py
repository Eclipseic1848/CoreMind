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


def observability(sequence: int = 0) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "localEnabled": True,
        "derivedFromSequence": sequence,
        "run": {"status": "finished", "resumable": False},
        "turns": {"started": 1, "completed": 1, "active": 0},
        "calls": {
            "started": 0,
            "completed": 0,
            "failed": 0,
            "active": 0,
            "durationMs": 0,
        },
        "tools": [],
        "errors": [],
        "context": {"budgets": 1, "compactions": 0, "failures": 0},
        "artifacts": {"stored": 0, "blocked": 0},
        "sharedState": {"pendingControls": 0},
        "recovery": {"resumable": False},
        "telemetry": {
            "mode": "DISABLED",
            "source": "default",
            "exporterLoaded": False,
            "contentLevel": "metrics_only",
            "allowedFields": [],
            "queued": 0,
            "handedOff": 0,
            "failed": 0,
            "dropped": 0,
            "duplicates": 0,
            "shutdownTimedOut": False,
            "deliverySemantics": "best_effort_handoff_not_delivery",
            "authorizedScopes": [],
        },
    }


def tool_lifecycle() -> dict[str, object]:
    phases = [
        {"phase": phase, "status": "completed"}
        for phase in (
            "call_recorded",
            "capability_resolved",
            "policy_resolved",
            "approval_resolved",
            "lease_acquired",
            "checkpoint_durable",
            "started_durable",
            "executing",
            "observed",
            "result_durable",
            "terminal",
        )
    ]
    return {
        "version": 1,
        "agent": "main",
        "callId": "call-invalid",
        "tool": "lookup_order",
        "currentPhase": "terminal",
        "terminal": True,
        "phases": phases,
        "result": {
            "executionOutcome": "not_invoked",
            "effectState": "not_started",
            "persistenceState": "pending",
            "recoveryDisposition": "requires_human",
            "cleanupState": "not_needed",
            "authorizationState": "pending",
            "environmentState": "available",
        },
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
                "result": {
                    "protocolVersion": "1.0",
                    "capabilities": ["runSnapshot", "localObservability"],
                },
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
    elif method == "run" and params.get("input") == "坏观测":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": "run-bad-observability",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": snapshot(
                        "run-bad-observability",
                        {"status": "succeeded", "finishReason": "completed"},
                    ),
                    "observability": {"schemaVersion": 2},
                },
            }
        )
    elif method == "run" and params.get("input") in {
        "坏观测嵌套",
        "坏观测关闭超时",
        "坏观测失败码",
        "坏观测工具阶段",
        "坏观测工具状态",
        "坏观测工具轴",
    }:
        malformed = observability(3)
        if params.get("input") == "坏观测嵌套":
            malformed["context"] = None
        elif params.get("input") == "坏观测关闭超时":
            del malformed["telemetry"]["shutdownTimedOut"]
        elif params.get("input") == "坏观测失败码":
            malformed["telemetry"]["lastFailure"] = "unknown_failure"
        elif params.get("input") == "坏观测工具阶段":
            malformed["tools"] = [
                {
                    "version": 1,
                    "agent": "main",
                    "callId": "call-invalid",
                    "tool": "lookup_order",
                    "currentPhase": "terminal",
                    "terminal": True,
                    "phases": [{"phase": "terminal", "status": "completed"}],
                    "result": {},
                }
            ]
        elif params.get("input") == "坏观测工具状态":
            invalid_tool = tool_lifecycle()
            invalid_tool["phases"][0] = {
                "phase": "call_recorded",
                "status": "failed",
                "reason": "invalid",
            }
            malformed["tools"] = [invalid_tool]
        else:
            invalid_tool = tool_lifecycle()
            invalid_tool["phases"][1] = {
                "phase": "capability_resolved",
                "status": "completed",
                "result": {"executionOutcome": "returned"},
            }
            malformed["tools"] = [invalid_tool]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": "run-bad-observability-nested",
                    "outcome": {"status": "succeeded", "finishReason": "completed"},
                    "snapshot": snapshot(
                        "run-bad-observability-nested",
                        {"status": "succeeded", "finishReason": "completed"},
                    ),
                    "observability": malformed,
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
                    "observability": observability(3),
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
                    "observability": observability(3),
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
                    "observability": observability(3),
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
                    "observability": observability(3),
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
