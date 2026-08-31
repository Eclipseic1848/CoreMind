"""Python SDK 单元测试使用的最小协议 worker。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

pending_run_id: int | None = None
selected_protocol = "1.0"
MANIFEST = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "src"
        / "coremind"
        / "_worker"
        / "manifest.json"
    ).read_text(encoding="utf-8")
)


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


def child_runs(run_id: str) -> dict[str, object]:
    node = {
        "parentRunId": run_id,
        "childRunId": "child-1",
        "delegationId": "delegation-1",
        "status": "joined",
        "children": [],
    }
    return {
        "roots": [node],
        "nodes": [node],
        "activeDescendants": 0,
        "unhandledDescendants": 0,
        "quiescent": True,
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
        if "protocolRange" in params:
            selected_protocol = "2.0"
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "selectedProtocol": "2.0",
                        "serverCapabilities": [
                            "runHandle",
                            "typedEvents",
                            "cursorResume",
                            "controlInbox",
                            "projectionQuery",
                            "checkpointOperations",
                            "dynamicTools",
                        ],
                        "schemaFingerprint": (
                            "sha256:" + "0" * 64
                            if params.get("config", {}).get("name") == "bad-fingerprint"
                            else MANIFEST["protocolV2SchemaFingerprint"]
                        ),
                        "runtime": "node",
                        "warnings": [],
                        "migration": {
                            "v1Supported": True,
                            "v1SupportedThrough": "0.4.x",
                            "earliestRemoval": "0.5.0",
                        },
                    },
                }
            )
            continue
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
    elif selected_protocol == "2.0" and method in {"run", "chat", "resume"}:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "runId": params["runId"],
                    "acceptedAt": "2026-08-25T00:00:00.000Z",
                    "initialCursor": 0,
                    "selectedProtocol": "2.0",
                    "availableControls": ["cancel", "approval", "steering", "follow_up"],
                },
            }
        )
    elif selected_protocol == "2.0" and method == "events":
        if params["runId"] == "expired-run":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32000,
                        "message": "事件游标已过期",
                        "data": {
                            "coremindCode": "cursor_expired",
                            "details": {
                                "recovery": {
                                    "runId": "expired-run",
                                    "newCursor": 7,
                                    "derivedFromSequence": 7,
                                    "projection": {"status": "interrupted"},
                                }
                            },
                        },
                    },
                }
            )
            continue
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "schemaVersion": 1,
                    "runId": params["runId"],
                    "afterSequence": params["afterSequence"],
                    "nextCursor": 1,
                    "hasMore": False,
                    "events": [
                        {
                            "protocolVersion": "2.0",
                            "eventType": "fact.start",
                            "eventSchemaVersion": 1,
                            "runId": params["runId"],
                            "sequence": 1,
                            "eventId": "start-1",
                            "timestamp": "2026-08-25T00:00:00.000Z",
                            "payload": {},
                            "ignorable": False,
                            "sensitivity": "local",
                        }
                    ],
                },
            }
        )
    elif selected_protocol == "2.0" and method == "query":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "schemaVersion": 1,
                    "runId": params["runId"],
                    "derivedFromSequence": 1,
                    "projection": {
                        "runId": params["runId"],
                        "status": "interrupted",
                        "childRuns": child_runs(params["runId"]),
                    },
                },
            }
        )
    elif selected_protocol == "2.0" and method == "control":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "schemaVersion": 1,
                    "controlId": params["controlId"],
                    "runId": params["runId"],
                    "status": "applied",
                    "appliedSequence": 2,
                },
            }
        )
    elif selected_protocol == "2.0" and method == "checkpoint":
        action = params["action"]
        checkpoint = {
            "checkpointVersion": 1,
            "checkpointId": "checkpoint-1",
            "runId": params["runId"],
            "createdAt": "2026-08-30T00:00:00.000Z",
            "reversible": True,
            "path": "result.txt",
            "before": {"existed": True, "sha256": "b" * 64},
        }
        if action == "list":
            result = {
                "schemaVersion": 1,
                "action": "list",
                "runId": params["runId"],
                "derivedFromSequence": 1,
                "checkpoints": [checkpoint],
            }
            invalid_sequences = {
                "checkpoint-sequence-negative": -1,
                "checkpoint-sequence-zero": 0,
                "checkpoint-sequence-bool": False,
            }
            if params["runId"] in invalid_sequences:
                result["derivedFromSequence"] = invalid_sequences[params["runId"]]
            elif params["runId"] == "checkpoint-empty-id":
                checkpoint["checkpointId"] = ""
            elif params["runId"] == "checkpoint-invalid-time":
                checkpoint["createdAt"] = "not-a-timestamp"
            invalid_file_states = {
                "checkpoint-existing-without-sha": {"existed": True},
                "checkpoint-missing-with-sha": {
                    "existed": False,
                    "sha256": "a" * 64,
                },
                "checkpoint-missing-with-null-sha": {
                    "existed": False,
                    "sha256": None,
                },
            }
            if params["runId"] in invalid_file_states:
                checkpoint["before"] = invalid_file_states[params["runId"]]
        elif action == "create":
            result = {
                "schemaVersion": 1,
                "action": "create",
                "operationId": params["operationId"],
                "status": "applied",
                "runId": params["runId"],
                "checkpoint": checkpoint,
            }
        elif action == "diff":
            result = {
                "schemaVersion": 1,
                "action": "diff",
                "runId": params["runId"],
                "checkpointId": params["checkpointId"],
                "checkpointVersion": 1,
                "path": "result.txt",
                "changed": True,
                "before": {"existed": True, "sha256": "b" * 64},
                "current": {"existed": True, "sha256": "a" * 64},
                "reversible": True,
            }
        else:
            result = {
                "schemaVersion": 1,
                "action": "restore",
                "operationId": params["operationId"],
                "status": "applied",
                "runId": params["runId"],
                "checkpointId": params["checkpointId"],
                "checkpointVersion": 1,
            }
        send({"jsonrpc": "2.0", "id": request_id, "result": result})
    elif selected_protocol == "2.0" and method == "tool_register":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "schemaVersion": 1,
                    "registrationId": params["registrationId"],
                    "toolId": params["toolId"],
                    "definitionFingerprint": "sha256:" + "c" * 64,
                    "status": "registered",
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "protocolVersion": "2.0",
                "method": "tool_call",
                "params": {
                    "schemaVersion": 1,
                    "runId": "python-v2-run",
                    "callId": "call-python-1",
                    "registrationId": params["registrationId"],
                    "toolId": params["toolId"],
                    "name": params["name"],
                    "argumentsFingerprint": "sha256:" + "d" * 64,
                    "args": {"id": "42"},
                },
            }
        )
    elif selected_protocol == "2.0" and method == "tool_result":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "schemaVersion": 1,
                    "resultId": params["resultId"],
                    "runId": params["runId"],
                    "callId": params["callId"],
                    "registrationId": params["registrationId"],
                    "status": "accepted",
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
    elif method == "run" and params.get("input") == "未知错误码":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": "自定义 Worker 返回了未知错误码",
                    "data": {
                        "coremindCode": "vendor_private_error",
                        "details": {"source": "synthetic-custom-worker"},
                    },
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
                    "childRuns": child_runs("run-1"),
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
