"""任务与会话导航的线协议响应校验；状态和执行仍由 Node 持有。"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .errors import ProtocolError

_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")
_SESSION_ID = re.compile(r"^[a-zA-Z0-9_-]{1,256}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")


def _invalid() -> ProtocolError:
    return ProtocolError("任务或会话响应结构、身份不匹配", rpc_code=-32600,
                         coremind_code="protocol_validation_failed")


def _shape(value: object, required: set[str], optional: set[str] = frozenset()) -> bool:
    return isinstance(value, dict) and required <= value.keys() <= required | optional


def _id(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _integer(value: object, minimum: int = 0, maximum: int = 9_007_199_254_740_991) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _sleep(value: object) -> bool:
    return (_shape(value, {"sleepId", "wakeAt"}) and _id(value["sleepId"])
            and _integer(value["wakeAt"], maximum=8_640_000_000_000_000))


def _task(value: object, task_id: str) -> bool:
    return (_shape(value, {"taskId", "type", "version", "phase", "status", "checkpoint"},
                   {"pendingRunId", "sleep"})
            and value["taskId"] == task_id and _id(value["type"]) and _id(value["phase"])
            and _integer(value["version"], 1)
            and isinstance(value["status"], str)
            and value["status"] in {"ready", "paused", "sleeping", "completed", "cancelled"}
            and ("pendingRunId" not in value or _id(value["pendingRunId"]))
            and ("sleep" not in value or _sleep(value["sleep"])))


def _call(value: object) -> bool:
    if not (_shape(value, {"key", "tool", "args", "signature", "stepId", "status",
                           "runId", "phase", "version", "authority"}, {"error", "result"})
            and all(_id(value[key]) for key in ("key", "runId", "phase"))
            and all(isinstance(value[key], str) and _HASH.fullmatch(value[key])
                    for key in ("signature", "stepId", "authority"))
            and isinstance(value["tool"], str) and value["tool"]
            and _integer(value["version"], 1)
            and isinstance(value["status"], str)
            and value["status"] in {"pending", "completed", "failed", "cancelled"}
            and ("error" not in value or isinstance(value["error"], str))):
        return False
    if "result" not in value:
        return True
    result = value["result"]
    return (_shape(result, {"content", "details"}) and isinstance(result["content"], list)
            and all(isinstance(item, dict) for item in result["content"]))


def _tree(value: object, request: Mapping[str, Any]) -> bool:
    if not (_shape(value, {"sessionId", "activeBranch", "branches", "nodes"}, {"forkedFrom"})
            and isinstance(value["sessionId"], str) and _SESSION_ID.fullmatch(value["sessionId"])
            and isinstance(value["activeBranch"], str) and value["activeBranch"]
            and isinstance(value["branches"], list) and isinstance(value["nodes"], list)):
        return False
    for branch in value["branches"]:
        if not (_shape(branch, {"id", "leafId"}) and isinstance(branch["id"], str)
                and branch["id"] and (branch["leafId"] is None or isinstance(branch["leafId"], str))):
            return False
    for node in value["nodes"]:
        if not (_shape(node, {"id", "parentId", "seq", "type"}, {"message", "summary"})
                and isinstance(node["id"], str) and node["id"] and _integer(node["seq"])
                and (node["parentId"] is None or isinstance(node["parentId"], str))
                and isinstance(node["type"], str)
                and node["type"] in {"message", "model_change", "thinking_level_change",
                                     "active_tools_change", "compaction", "branch_summary", "custom"}
                and ("message" not in node or isinstance(node["message"], dict))
                and ("summary" not in node or isinstance(node["summary"], str))):
            return False
    origin = value.get("forkedFrom")
    if origin is not None and not (_shape(origin, {"sessionId", "entryId"})
                                  and all(isinstance(item, str) and item for item in origin.values())
                                  and _SESSION_ID.fullmatch(origin["sessionId"])):
        return False
    if request["action"] == "fork":
        return (value["sessionId"] != request["sessionId"] and origin is not None
                and origin == {"sessionId": request["sessionId"], "entryId": request["at"]["entryId"]})
    return value["sessionId"] == request["sessionId"]


def validate_management_result(value: object, method: str, request: Mapping[str, Any]) -> dict[str, Any]:
    if not (isinstance(value, dict) and type(value.get("schemaVersion")) is int
            and value["schemaVersion"] == 1 and value.get("sessionId") == request["sessionId"]
            and value.get("action") == request["action"]):
        raise _invalid()
    base = {"schemaVersion", "sessionId", "action"}
    action = request["action"]
    valid = False
    if method == "session":
        valid = _shape(value, base | {"tree"}) and _tree(value["tree"], request)
    elif action == "next_wake":
        deadline = value.get("deadline")
        valid = _shape(value, base | {"deadline"}) and (
            deadline is None or (_shape(deadline, {"taskId", "sleepId", "wakeAt", "remainingMs"})
                                 and _id(deadline["taskId"]) and _id(deadline["sleepId"])
                                 and _integer(deadline["wakeAt"], maximum=8_640_000_000_000_000)
                                 and _integer(deadline["remainingMs"])))
    elif value.get("taskId") == request["taskId"]:
        if action == "calls":
            valid = (_shape(value, base | {"taskId", "calls"}) and isinstance(value["calls"], list)
                     and all(_call(item) for item in value["calls"]))
        elif action == "wake":
            valid = (_shape(value, base | {"taskId", "task", "wakeId", "sleepId", "wakeStatus"})
                     and value["wakeId"] == request["wakeId"] and value["sleepId"] == request["sleepId"]
                     and isinstance(value["wakeStatus"], str)
                     and value["wakeStatus"] in {"accepted", "duplicate", "not_due", "stale", "terminal"}
                     and _task(value["task"], request["taskId"]))
        else:
            valid = (_shape(value, base | {"taskId", "task"})
                     and ((action == "query" and value["task"] is None)
                          or _task(value["task"], request["taskId"])))
    if not valid:
        raise _invalid()
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError) as error:
        raise _invalid() from error


def validate_management_error(error: ProtocolError, method: str, request: Mapping[str, Any]) -> None:
    details = error.details
    if isinstance(details, Mapping) and "operation" in details:
        if (details["operation"] != method or details.get("sessionId") != request["sessionId"]
                or details.get("action") != request["action"]
                or ("taskId" in request and details.get("taskId") != request["taskId"])):
            raise _invalid() from error

