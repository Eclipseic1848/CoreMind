"""CoreMind 常驻 Node worker 客户端。"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import uuid
from collections import deque
from pathlib import Path, PurePosixPath, PureWindowsPath
from types import UnionType
from typing import Any, Callable, Mapping, Sequence, Union, get_args, get_origin
from urllib.parse import urlsplit

from .errors import CoreMindError, ProtocolError, WorkerExitedError, WorkerNotFoundError

PROTOCOL_VERSION = "1.0"
PROTOCOL_V2_VERSION = "2.0"
ApprovalHandler = Callable[[Mapping[str, Any]], str]
EventHandler = Callable[[Mapping[str, Any]], None]
_MISSING = object()


class CoreMindClient:
    """同步 Python SDK；每个实例维护一个常驻 Node worker。"""

    def __init__(
        self,
        config: Mapping[str, Any] | str | os.PathLike[str],
        *,
        config_dir: str | os.PathLike[str] | None = None,
        cwd: str | os.PathLike[str] | None = None,
        session_id: str | None = None,
        worker_command: Sequence[str] | None = None,
        event_handler: EventHandler | None = None,
        approval_handler: ApprovalHandler | None = None,
        request_timeout: float = 300.0,
        protocol_version: str = PROTOCOL_VERSION,
    ) -> None:
        if protocol_version not in {PROTOCOL_VERSION, PROTOCOL_V2_VERSION}:
            raise ValueError("protocol_version 只支持 1.0 或 2.0")
        self._config = config
        self._config_dir = Path(config_dir).resolve() if config_dir else None
        self._cwd = Path(cwd).resolve() if cwd else None
        self._session_id = session_id
        self._worker_command = list(worker_command) if worker_command else None
        self._event_handler = event_handler
        self._approval_handler = approval_handler
        self._request_timeout = request_timeout
        self._protocol_version = protocol_version
        self._process: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._stderr_tail: deque[str] = deque(maxlen=50)
        self._write_lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._pending_lock = threading.Lock()
        self._pending: dict[int, queue.Queue[Mapping[str, Any] | BaseException]] = {}
        self._next_id = 1
        self._started = False
        self._closed = False
        self._capabilities: frozenset[str] = frozenset()
        self._tools: dict[str, tuple[Callable[..., Any], dict[str, Any]]] = {}
        self.received_events: list[Mapping[str, Any]] = []
        self.received_tool_calls: list[Mapping[str, Any]] = []
        self.received_tool_cancellations: list[Mapping[str, Any]] = []
        self.received_verification_requests: list[Mapping[str, Any]] = []

    @property
    def pid(self) -> int | None:
        """返回常驻 worker 进程号。"""

        return self._process.pid if self._process else None

    def start(self) -> "CoreMindClient":
        """启动 worker、协商协议并注册已有 Python 工具。"""

        with self._lifecycle_lock:
            if self._closed:
                raise CoreMindError("客户端已关闭")
            if self._started:
                return self
            if self._protocol_version == PROTOCOL_V2_VERSION and self._tools:
                raise ProtocolError(
                    "Protocol v2 尚未开放 Python callable 注册；不能混用 v1 register_tool",
                    rpc_code=-32601,
                    coremind_code="protocol_capability_missing",
                )
            command = self._worker_command or _discover_worker_command()
            if self._worker_command is None:
                _verify_bundled_worker(command)
            try:
                self._process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                    cwd=str(self._cwd) if self._cwd else None,
                    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                )
            except OSError as error:
                raise WorkerNotFoundError(f"无法启动 CoreMind worker：{error}") from error
            self._reader = threading.Thread(target=self._reader_loop, daemon=True)
            self._stderr_reader = threading.Thread(target=self._stderr_loop, daemon=True)
            self._reader.start()
            self._stderr_reader.start()
            try:
                initialize_params = (
                    self._initialize_v2_params()
                    if self._protocol_version == PROTOCOL_V2_VERSION
                    else self._initialize_params()
                )
                result = self._request_raw("initialize", initialize_params)
                selected = (
                    result.get("selectedProtocol")
                    if self._protocol_version == PROTOCOL_V2_VERSION
                    else result.get("protocolVersion")
                )
                if selected != self._protocol_version:
                    raise ProtocolError(
                        f"协议版本不匹配：SDK={self._protocol_version}，worker={selected}",
                        rpc_code=-32000,
                        coremind_code="protocol_version_mismatch",
                    )
                if self._protocol_version == PROTOCOL_V2_VERSION:
                    _validate_v2_initialize_result(result)
                capabilities = result.get(
                    "serverCapabilities" if self._protocol_version == PROTOCOL_V2_VERSION else "capabilities",
                    [],
                )
                required_capabilities = (
                    {
                        "runHandle",
                        "typedEvents",
                        "cursorResume",
                        "controlInbox",
                        "projectionQuery",
                        "checkpointOperations",
                        "dynamicTools",
                    }
                    if self._protocol_version == PROTOCOL_V2_VERSION
                    else {"runSnapshot"}
                )
                missing_capabilities = required_capabilities.difference(capabilities)
                if missing_capabilities:
                    raise ProtocolError(
                        f"worker 缺少当前 SDK 要求的能力：{', '.join(sorted(missing_capabilities))}",
                        rpc_code=-32000,
                        coremind_code="protocol_capability_missing",
                    )
                self._capabilities = frozenset(
                    capability
                    for capability in capabilities
                    if isinstance(capability, str)
                )
                if self._protocol_version == PROTOCOL_VERSION:
                    for spec in self._tools.values():
                        self._register_tool_spec(spec[1])
            except BaseException:
                self._terminate_process()
                self._process = None
                raise
            self._started = True
            return self

    def run(self, input: str | None = None, *, run_id: str | None = None) -> dict[str, Any]:
        """执行一次 Run，返回与 TypeScript SDK 等价的 JSON 结果。"""

        self.start()
        params: dict[str, Any] = {}
        if input is not None:
            params["input"] = input
        if run_id is not None or self._protocol_version == PROTOCOL_V2_VERSION:
            params["runId"] = run_id or uuid.uuid4().hex
        if self._protocol_version == PROTOCOL_V2_VERSION:
            return _validate_run_handle(self._request_raw("run", params), str(params["runId"]))
        return _validate_run_result(
            self._request_raw("run", params),
            require_observability="localObservability" in self._capabilities,
        )

    def chat(
        self, message: str, *, agent: str = "main", run_id: str | None = None
    ) -> dict[str, Any]:
        """在常驻 worker 中发起一次聊天请求。"""

        self.start()
        params = {"agent": agent, "message": message}
        if self._protocol_version == PROTOCOL_V2_VERSION:
            params["runId"] = run_id or uuid.uuid4().hex
            return _validate_run_handle(self._request_raw("chat", params), str(params["runId"]))
        return _validate_run_result(
            self._request_raw("chat", params),
            require_observability="localObservability" in self._capabilities,
        )

    def cancel(self, run_id: str) -> None:
        """取消指定的活动运行。"""

        self.start()
        if self._protocol_version == PROTOCOL_V2_VERSION:
            self.control(
                {
                    "schemaVersion": 1,
                    "controlId": uuid.uuid4().hex,
                    "runId": run_id,
                    "type": "cancel",
                }
            )
            return
        self._request_raw("cancel", {"runId": run_id})

    def inspect_run(self, run_id: str) -> dict[str, Any]:
        """读取 append-only RunState、完成状态与 checkpoint 列表。"""

        self.start()
        if self._protocol_version == PROTOCOL_V2_VERSION:
            return self.query(run_id)
        result = dict(self._request_raw("inspect_run", {"runId": run_id}))
        if "localObservability" in self._capabilities:
            _validate_observability(result.get("observability"))
        return result

    def resume_run(self, run_id: str, *, input: str | None = None) -> dict[str, Any]:
        """从意外中断或显式暂停运行的最近稳定边界继续执行。"""

        self.start()
        params: dict[str, Any] = {"runId": run_id}
        if input is not None:
            params["input"] = input
        if self._protocol_version == PROTOCOL_V2_VERSION:
            return _validate_run_handle(self._request_raw("resume", params), run_id)
        return _validate_run_result(
            self._request_raw("resume_run", params),
            require_observability="localObservability" in self._capabilities,
        )

    def checkpoint_list(self, run_id: str) -> dict[str, Any]:
        """列出脱敏后的 Protocol v2 Checkpoint。"""

        self.start()
        self._require_v2_method("checkpoint_list")
        return _validate_checkpoint_result(
            self._request_raw(
                "checkpoint",
                {"schemaVersion": 1, "action": "list", "runId": run_id},
            ),
            action="list",
            run_id=run_id,
        )

    def checkpoint_create(
        self,
        run_id: str,
        path: str,
        *,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """为工作区路径显式创建 Protocol v2 Checkpoint。"""

        self.start()
        self._require_v2_method("checkpoint_create")
        identity = operation_id or uuid.uuid4().hex
        return _validate_checkpoint_result(
            self._request_raw(
                "checkpoint",
                {
                    "schemaVersion": 1,
                    "action": "create",
                    "operationId": identity,
                    "runId": run_id,
                    "path": path,
                },
            ),
            action="create",
            run_id=run_id,
            operation_id=identity,
        )

    def checkpoint_diff(self, run_id: str, checkpoint_id: str) -> dict[str, Any]:
        """比较 checkpoint 前内容与当前工作区文件。"""

        self.start()
        if self._protocol_version == PROTOCOL_V2_VERSION:
            return _validate_checkpoint_result(
                self._request_raw(
                    "checkpoint",
                    {
                        "schemaVersion": 1,
                        "action": "diff",
                        "runId": run_id,
                        "checkpointId": checkpoint_id,
                        "checkpointVersion": 1,
                    },
                ),
                action="diff",
                run_id=run_id,
                checkpoint_id=checkpoint_id,
            )
        self._require_v1_method("checkpoint_diff")
        return dict(
            self._request_raw(
                "checkpoint_diff", {"runId": run_id, "checkpointId": checkpoint_id}
            )
        )

    def checkpoint_restore(
        self,
        run_id: str,
        checkpoint_id: str,
        *,
        confirm: bool,
        operation_id: str | None = None,
        expected_current: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """在调用方显式 confirm=True 后恢复可逆 checkpoint。"""

        if confirm is not True:
            raise CoreMindError("恢复 checkpoint 必须显式传入 confirm=True")
        self.start()
        if self._protocol_version == PROTOCOL_V2_VERSION:
            if not isinstance(expected_current, Mapping):
                raise CoreMindError("Protocol v2 恢复 checkpoint 必须提供 diff 返回的 expected_current")
            identity = operation_id or uuid.uuid4().hex
            return _validate_checkpoint_result(
                self._request_raw(
                    "checkpoint",
                    {
                        "schemaVersion": 1,
                        "action": "restore",
                        "operationId": identity,
                        "runId": run_id,
                        "checkpointId": checkpoint_id,
                        "checkpointVersion": 1,
                        "confirm": True,
                        "expectedCurrent": dict(expected_current),
                    },
                ),
                action="restore",
                run_id=run_id,
                operation_id=identity,
                checkpoint_id=checkpoint_id,
            )
        self._require_v1_method("checkpoint_restore")
        return dict(
            self._request_raw(
                "checkpoint_restore",
                {"runId": run_id, "checkpointId": checkpoint_id, "confirm": True},
            )
        )

    def events(
        self, run_id: str, *, after_sequence: int, limit: int | None = None
    ) -> dict[str, Any]:
        """按 durable sequence 拉取 Protocol v2 事件页。"""

        self.start()
        self._require_v2_method("events")
        params: dict[str, Any] = {"runId": run_id, "afterSequence": after_sequence}
        if limit is not None:
            params["limit"] = limit
        return _validate_events_page(self._request_raw("events", params), run_id)

    def query(self, run_id: str) -> dict[str, Any]:
        """读取由 ProjectionEngine 生成的 Protocol v2 查询结果。"""

        self.start()
        self._require_v2_method("query")
        return _validate_query_result(self._request_raw("query", {"runId": run_id}), run_id)

    def control(self, command: Mapping[str, Any]) -> dict[str, Any]:
        """提交 Protocol v2 持久控制命令并返回回执。"""

        self.start()
        self._require_v2_method("control")
        if command.get("type") == "verification":
            if "hostVerification" not in self._capabilities:
                raise ProtocolError("worker 不支持宿主验收", rpc_code=-32601,
                                    coremind_code="protocol_capability_missing")
            _validate_verification_control(command)
        return _validate_control_receipt(self._request_raw("control", command), command)

    def submit_verification(
        self, run_id: str, request_id: str, candidate_sha256: str, *,
        decision: str, feedback: str = "", control_id: str | None = None,
    ) -> dict[str, Any]:
        """提交宿主验收决定；重复发送时应复用同一个 control_id。"""

        command = {"schemaVersion": 1, "type": "verification", "runId": run_id,
                   "requestId": request_id, "candidateSha256": candidate_sha256,
                   "decision": decision, "feedback": feedback,
                   "controlId": control_id if control_id is not None else uuid.uuid4().hex}
        _validate_verification_control(command)
        return self.control(command)

    def tool(
        self,
        *,
        effect: Mapping[str, Any],
        name: str | None = None,
        description: str | None = None,
        parameters: Mapping[str, Any] | None = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """把同步或异步 Python callable 注册为 Agent 工具。"""

        if self._protocol_version == PROTOCOL_V2_VERSION:
            raise ProtocolError(
                "Protocol v2 只接受声明式工具；不得注册宿主 Python callable",
                rpc_code=-32601,
                coremind_code="protocol_capability_missing",
            )

        def decorator(function: Callable[..., Any]) -> Callable[..., Any]:
            tool_name = name or function.__name__
            if tool_name in self._tools:
                raise CoreMindError(f"Python 工具 {tool_name} 已注册")
            spec = {
                "name": tool_name,
                "description": description or inspect.getdoc(function) or tool_name,
                "parameters": dict(parameters) if parameters else _schema_from_callable(function),
                "effect": _normalize_tool_effect(effect),
            }
            self._tools[tool_name] = (function, spec)
            if self._started:
                self._register_tool_spec(spec)
            return function

        return decorator

    def register_tool_definition(self, definition: Mapping[str, Any]) -> dict[str, Any]:
        """注册声明式 v2 工具定义；不接收或执行 Python callable。"""

        self.start()
        self._require_v2_method("tool_register")
        try:
            json.dumps(definition, ensure_ascii=False)
        except (TypeError, ValueError) as error:
            raise CoreMindError("工具定义必须是可序列化的 JSON 声明") from error
        result = self._request_raw("tool_register", dict(definition))
        return _validate_tool_registration_receipt(result, definition)

    def submit_tool_result(
        self,
        run_id: str,
        call_id: str,
        registration_id: str,
        *,
        result: Any = _MISSING,
        error: str | None = None,
        result_id: str | None = None,
    ) -> dict[str, Any]:
        """显式提交 v2 工具结果；结果不会在 Python SDK 内自动执行。"""

        self.start()
        self._require_v2_method("tool_result")
        if (result is _MISSING) == (error is None):
            raise CoreMindError("工具结果必须且只能提供 result 或 error 之一")
        identity = result_id or uuid.uuid4().hex
        params: dict[str, Any] = {
            "schemaVersion": 1,
            "resultId": identity,
            "runId": run_id,
            "callId": call_id,
            "registrationId": registration_id,
        }
        params["error" if error is not None else "result"] = error if error is not None else result
        return _validate_tool_result_receipt(self._request_raw("tool_result", params), params)

    def close(self) -> None:
        """关闭 worker；可重复调用。"""

        with self._lifecycle_lock:
            if self._closed:
                return
            if (
                self._protocol_version == PROTOCOL_VERSION
                and self._process
                and self._process.poll() is None
            ):
                try:
                    self._request_raw("close", {}, timeout=5.0)
                except CoreMindError:
                    pass
            self._closed = True
            self._started = False
            self._terminate_process()

    def __enter__(self) -> "CoreMindClient":
        return self.start()

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def _initialize_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {"protocolVersion": PROTOCOL_VERSION}
        if isinstance(self._config, Mapping):
            params["config"] = dict(self._config)
            params["configDir"] = str(self._config_dir or Path.cwd())
        else:
            config_path = Path(self._config).resolve()
            params["configPath"] = str(config_path)
            if self._config_dir:
                params["configDir"] = str(self._config_dir)
        if self._cwd:
            params["cwd"] = str(self._cwd)
        if self._session_id:
            params["sessionId"] = self._session_id
        return params

    def _initialize_v2_params(self) -> dict[str, Any]:
        params = self._initialize_params()
        params.pop("protocolVersion", None)
        params["protocolRange"] = {
            "minVersion": PROTOCOL_V2_VERSION,
            "maxVersion": PROTOCOL_V2_VERSION,
        }
        params["capabilities"] = [
            "runHandle",
            "typedEvents",
            "cursorResume",
            "controlInbox",
            "projectionQuery",
            "checkpointOperations",
            "dynamicTools",
            "hostVerification",
        ]
        return params

    def _require_v1_method(self, method: str) -> None:
        if self._protocol_version != PROTOCOL_VERSION:
            raise ProtocolError(
                f"Protocol v2 不支持 {method}；请使用 v2 query/control 合同",
                rpc_code=-32601,
                coremind_code="protocol_capability_missing",
            )

    def _require_v2_method(self, method: str) -> None:
        if self._protocol_version != PROTOCOL_V2_VERSION:
            raise ProtocolError(
                f"{method} 仅属于 Protocol v2",
                rpc_code=-32601,
                coremind_code="protocol_capability_missing",
            )

    def _register_tool_spec(self, spec: Mapping[str, Any]) -> None:
        self._request_raw("register_tool", dict(spec))

    def _request_raw(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        timeout: float | None = None,
    ) -> Mapping[str, Any]:
        process = self._process
        if not process or process.poll() is not None or not process.stdin:
            raise self._worker_exited_error()
        with self._pending_lock:
            request_id = self._next_id
            self._next_id += 1
            response_queue: queue.Queue[Mapping[str, Any] | BaseException] = queue.Queue(maxsize=1)
            self._pending[request_id] = response_queue
        request = {
            "jsonrpc": "2.0",
            **(
                {"protocolVersion": PROTOCOL_V2_VERSION}
                if self._protocol_version == PROTOCOL_V2_VERSION and method != "initialize"
                else {}
            ),
            "id": request_id,
            "method": method,
            "params": dict(params),
        }
        try:
            with self._write_lock:
                process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
                process.stdin.flush()
            response = response_queue.get(timeout=timeout or self._request_timeout)
        except queue.Empty as error:
            raise CoreMindError(f"协议请求 {method} 超时") from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)
        if isinstance(response, BaseException):
            raise response
        if "error" in response:
            error = response["error"]
            data = error.get("data") or {}
            raise ProtocolError(
                str(error.get("message", "CoreMind 协议错误")),
                rpc_code=int(error.get("code", -32000)),
                coremind_code=data.get("coremindCode"),
                details=data.get("details"),
            )
        result = response.get("result")
        return result if isinstance(result, Mapping) else {"value": result}

    def _reader_loop(self) -> None:
        process = self._process
        if not process or not process.stdout:
            return
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self._stderr_tail.append(f"worker 输出了非法 JSON：{line.rstrip()}")
                    continue
                if isinstance(message, Mapping) and "method" in message:
                    self._handle_notification(message)
                    continue
                request_id = message.get("id") if isinstance(message, Mapping) else None
                if isinstance(request_id, int):
                    with self._pending_lock:
                        pending = self._pending.get(request_id)
                    if pending:
                        pending.put(message)
        finally:
            error = self._worker_exited_error()
            with self._pending_lock:
                pending_queues = list(self._pending.values())
            for pending in pending_queues:
                try:
                    pending.put_nowait(error)
                except queue.Full:
                    pass

    def _stderr_loop(self) -> None:
        process = self._process
        if not process or not process.stderr:
            return
        for line in process.stderr:
            self._stderr_tail.append(line.rstrip())

    def _handle_notification(self, message: Mapping[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params")
        if method == "verification_request":
            try:
                if self._protocol_version != PROTOCOL_V2_VERSION or "hostVerification" not in self._capabilities:
                    raise ProtocolError("未协商宿主验收能力", rpc_code=-32601,
                                        coremind_code="protocol_capability_missing")
                self.received_verification_requests.append(parse_verification_request(message))
            except ProtocolError as error:
                self._stderr_tail.append(str(error))
            return
        if not isinstance(params, Mapping):
            return
        if method == "event":
            self.received_events.append(params)
            if self._event_handler:
                self._event_handler(params)
            event = params.get("event")
            if isinstance(event, Mapping) and event.get("type") == "approval_required":
                threading.Thread(
                    target=self._answer_approval,
                    args=(params, event),
                    daemon=True,
                ).start()
        elif method == "python_tool_call":
            threading.Thread(target=self._execute_python_tool, args=(params,), daemon=True).start()
        elif method == "tool_call" and self._protocol_version == PROTOCOL_V2_VERSION:
            try:
                if (
                    set(message) != {"jsonrpc", "protocolVersion", "method", "params"}
                    or message.get("jsonrpc") != "2.0"
                    or message.get("protocolVersion") != PROTOCOL_V2_VERSION
                ):
                    raise ProtocolError(
                        "worker 返回的 v2 ToolCall 版本非法",
                        rpc_code=-32600,
                        coremind_code="protocol_validation_failed",
                    )
                self.received_tool_calls.append(_validate_tool_call(params))
            except ProtocolError as error:
                self._stderr_tail.append(str(error))
        elif method == "tool_cancel" and self._protocol_version == PROTOCOL_V2_VERSION:
            try:
                if (
                    set(message) != {"jsonrpc", "protocolVersion", "method", "params"}
                    or message.get("jsonrpc") != "2.0"
                    or message.get("protocolVersion") != PROTOCOL_V2_VERSION
                ):
                    raise ProtocolError(
                        "worker 返回的 v2 ToolCancel 版本非法",
                        rpc_code=-32600,
                        coremind_code="protocol_validation_failed",
                    )
                self.received_tool_cancellations.append(_validate_tool_cancel(params))
            except ProtocolError as error:
                self._stderr_tail.append(str(error))

    def _answer_approval(
        self,
        params: Mapping[str, Any],
        event: Mapping[str, Any],
    ) -> None:
        try:
            decision = self._approval_handler(event) if self._approval_handler else "deny"
            if decision not in {"allow", "deny"}:
                decision = "deny"
            approval_id = str(event["approvalId"])
            if self._protocol_version == PROTOCOL_V2_VERSION:
                command = {
                    "schemaVersion": 1,
                    "controlId": hashlib.sha256(approval_id.encode("utf-8")).hexdigest(),
                    "runId": params["runId"],
                    "type": "approval",
                    "approvalId": approval_id,
                    "decision": decision,
                }
                _validate_control_receipt(self._request_raw("control", command), command)
                return
            self._request_raw(
                "approve",
                {
                    "runId": params["runId"],
                    "approvalId": approval_id,
                    "decision": decision,
                },
            )
        except CoreMindError as error:
            self._stderr_tail.append(str(error))

    def _execute_python_tool(self, params: Mapping[str, Any]) -> None:
        call_id = str(params.get("callId", ""))
        tool_name = str(params.get("tool", ""))
        registered = self._tools.get(tool_name)
        if not registered:
            self._send_tool_error(call_id, f"Python 工具 {tool_name} 未注册")
            return
        function, _spec = registered
        args = params.get("args")
        try:
            value = function(**dict(args)) if isinstance(args, Mapping) else function(args)
            if inspect.isawaitable(value):
                value = asyncio.run(value)
            self._request_raw("tool_result", {"callId": call_id, "result": value})
        except Exception as error:  # 工具异常必须跨协议返回
            self._send_tool_error(call_id, str(error))

    def _send_tool_error(self, call_id: str, message: str) -> None:
        try:
            self._request_raw("tool_result", {"callId": call_id, "error": message})
        except CoreMindError:
            return

    def _worker_exited_error(self) -> WorkerExitedError:
        detail = "\n".join(self._stderr_tail)
        suffix = f"\nworker stderr:\n{detail}" if detail else ""
        return WorkerExitedError(f"CoreMind worker 已退出{suffix}")

    def _terminate_process(self) -> None:
        process = self._process
        if not process:
            return
        if process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()
        if self._reader and self._reader is not threading.current_thread():
            self._reader.join(timeout=1)
        if self._stderr_reader and self._stderr_reader is not threading.current_thread():
            self._stderr_reader.join(timeout=1)


class AsyncCoreMindClient:
    """同步客户端的 asyncio 适配器；协议和 Runtime 完全相同。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._client = CoreMindClient(*args, **kwargs)

    @property
    def sync_client(self) -> CoreMindClient:
        return self._client

    def tool(self, **kwargs: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._client.tool(**kwargs)

    async def start(self) -> "AsyncCoreMindClient":
        await asyncio.to_thread(self._client.start)
        return self

    async def run(
        self, input: str | None = None, *, run_id: str | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.run, input, run_id=run_id)

    async def chat(
        self, message: str, *, agent: str = "main", run_id: str | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.chat, message, agent=agent, run_id=run_id)

    async def cancel(self, run_id: str) -> None:
        await asyncio.to_thread(self._client.cancel, run_id)

    async def inspect_run(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.inspect_run, run_id)

    async def resume_run(self, run_id: str, *, input: str | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.resume_run, run_id, input=input)

    async def checkpoint_diff(self, run_id: str, checkpoint_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.checkpoint_diff, run_id, checkpoint_id)

    async def checkpoint_list(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.checkpoint_list, run_id)

    async def checkpoint_create(
        self, run_id: str, path: str, *, operation_id: str | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._client.checkpoint_create,
            run_id,
            path,
            operation_id=operation_id,
        )

    async def checkpoint_restore(
        self,
        run_id: str,
        checkpoint_id: str,
        *,
        confirm: bool,
        operation_id: str | None = None,
        expected_current: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._client.checkpoint_restore,
            run_id,
            checkpoint_id,
            confirm=confirm,
            operation_id=operation_id,
            expected_current=expected_current,
        )

    async def register_tool_definition(self, definition: Mapping[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.register_tool_definition, definition)

    async def submit_tool_result(
        self,
        run_id: str,
        call_id: str,
        registration_id: str,
        *,
        result: Any = _MISSING,
        error: str | None = None,
        result_id: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._client.submit_tool_result,
            run_id,
            call_id,
            registration_id,
            result=result,
            error=error,
            result_id=result_id,
        )

    async def events(
        self, run_id: str, *, after_sequence: int, limit: int | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._client.events,
            run_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    async def query(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.query, run_id)

    async def control(self, command: Mapping[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.control, command)

    async def submit_verification(
        self, run_id: str, request_id: str, candidate_sha256: str, *,
        decision: str, feedback: str = "", control_id: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.submit_verification, run_id, request_id,
            candidate_sha256, decision=decision, feedback=feedback, control_id=control_id)

    async def close(self) -> None:
        await asyncio.to_thread(self._client.close)

    async def __aenter__(self) -> "AsyncCoreMindClient":
        return await self.start()

    async def __aexit__(self, _type: object, _value: object, _traceback: object) -> None:
        await self.close()


def parse_verification_request(message: Mapping[str, Any]) -> dict[str, Any]:
    """校验专用本地通知的身份与候选内容摘要，返回宿主可验收的请求。"""

    params = message.get("params")
    candidate = params.get("candidate") if isinstance(params, Mapping) else None
    try:
        candidate_sha256 = hashlib.sha256(candidate.encode("utf-8")).hexdigest() if isinstance(candidate, str) else None
    except UnicodeEncodeError:
        candidate_sha256 = None
    if (
        set(message) != {"jsonrpc", "protocolVersion", "method", "params"}
        or message.get("jsonrpc") != "2.0" or message.get("protocolVersion") != PROTOCOL_V2_VERSION
        or message.get("method") != "verification_request"
        or not isinstance(params, Mapping)
        or set(params) != {"schemaVersion", "runId", "requestId", "stepId", "iteration", "candidateSha256", "candidate"}
        or type(params.get("schemaVersion")) is not int or params["schemaVersion"] != 1
        or not all(_valid_branded_id(params.get(key)) for key in ("runId", "requestId", "stepId"))
        or type(params.get("iteration")) is not int or params["iteration"] < 1
        or candidate_sha256 is None
        or params.get("candidateSha256") != candidate_sha256
    ):
        raise ProtocolError("宿主验收通知的身份或候选摘要非法", rpc_code=-32600,
                            coremind_code="protocol_validation_failed")
    return dict(params)


def _validate_verification_control(command: Mapping[str, Any]) -> None:
    if (
        set(command) != {"schemaVersion", "type", "runId", "controlId", "requestId",
                         "candidateSha256", "decision", "feedback"}
        or type(command.get("schemaVersion")) is not int or command["schemaVersion"] != 1
        or command.get("type") != "verification"
        or not all(_valid_branded_id(command.get(key)) for key in ("runId", "requestId", "controlId"))
        or not isinstance(command.get("candidateSha256"), str)
        or re.fullmatch(r"[0-9a-f]{64}", command["candidateSha256"]) is None
        or command.get("decision") not in ("accept", "reject")
        or not isinstance(command.get("feedback"), str)
        or (command["decision"] == "reject" and not command["feedback"].strip())
    ):
        raise ValueError("宿主验收控制的身份、摘要或决定非法")


def _validate_run_handle(value: Mapping[str, Any], expected_run_id: str) -> dict[str, Any]:
    result = dict(value)
    controls = result.get("availableControls")
    if (
        result.get("runId") != expected_run_id
        or not isinstance(result.get("acceptedAt"), str)
        or result.get("initialCursor") != 0
        or result.get("selectedProtocol") != PROTOCOL_V2_VERSION
        or not isinstance(controls, list)
        or not all(isinstance(item, str) for item in controls)
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 RunHandle 非法",
            rpc_code=-32600,
            coremind_code="invalid_run_handle",
        )
    return result


def _validate_checkpoint_result(
    value: Mapping[str, Any],
    *,
    action: str,
    run_id: str,
    operation_id: str | None = None,
    checkpoint_id: str | None = None,
) -> dict[str, Any]:
    result = dict(value)
    valid = result.get("schemaVersion") == 1 and result.get("action") == action
    valid = valid and result.get("runId") == run_id
    if action == "list":
        checkpoints = result.get("checkpoints")
        valid = (
            valid
            and set(result)
            == {"schemaVersion", "action", "runId", "derivedFromSequence", "checkpoints"}
            and _is_nonnegative_int(result.get("derivedFromSequence"))
            and result["derivedFromSequence"] > 0
            and isinstance(checkpoints, list)
            and all(_valid_public_checkpoint(item, run_id) for item in checkpoints)
        )
    elif action == "create":
        valid = (
            valid
            and set(result)
            == {"schemaVersion", "action", "operationId", "status", "runId", "checkpoint"}
            and result.get("operationId") == operation_id
            and result.get("status") in {"applied", "duplicate"}
            and _valid_public_checkpoint(result.get("checkpoint"), run_id)
        )
    elif action == "diff":
        valid = (
            valid
            and _valid_keys(
                result,
                {
                    "schemaVersion",
                    "action",
                    "runId",
                    "checkpointId",
                    "checkpointVersion",
                    "changed",
                    "current",
                    "reversible",
                },
                {"path", "before", "reason"},
            )
            and result.get("checkpointId") == checkpoint_id
            and result.get("checkpointVersion") == 1
            and isinstance(result.get("changed"), bool)
            and isinstance(result.get("reversible"), bool)
            and ("path" not in result or _valid_public_path(result.get("path")))
            and ("before" not in result or _valid_file_state(result.get("before")))
            and ("reason" not in result or isinstance(result.get("reason"), str))
            and _valid_file_state(result.get("current"))
        )
    elif action == "restore":
        valid = (
            valid
            and set(result)
            == {
                "schemaVersion",
                "action",
                "operationId",
                "status",
                "runId",
                "checkpointId",
                "checkpointVersion",
            }
            and result.get("operationId") == operation_id
            and result.get("checkpointId") == checkpoint_id
            and result.get("checkpointVersion") == 1
            and result.get("status") in {"applied", "duplicate"}
        )
    if not valid:
        raise ProtocolError(
            "worker 返回的 Protocol v2 CheckpointResult 非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )
    return result


def _valid_public_checkpoint(value: object, run_id: str) -> bool:
    if not isinstance(value, Mapping):
        return False
    return (
        _valid_keys(
            value,
            {"checkpointVersion", "checkpointId", "runId", "createdAt", "reversible"},
            {"operationId", "path", "before", "after", "reason"},
        )
        and value.get("checkpointVersion") == 1
        and _valid_branded_id(value.get("checkpointId"))
        and value.get("runId") == run_id
        and isinstance(value.get("createdAt"), str)
        and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z",
            value["createdAt"],
        )
        is not None
        and isinstance(value.get("reversible"), bool)
        and ("operationId" not in value or _valid_branded_id(value.get("operationId")))
        and ("path" not in value or _valid_public_path(value.get("path")))
        and ("before" not in value or _valid_file_state(value.get("before")))
        and ("after" not in value or _valid_file_state(value.get("after")))
        and ("reason" not in value or isinstance(value.get("reason"), str))
    )


def _valid_file_state(value: object) -> bool:
    if (
        not isinstance(value, Mapping)
        or not _valid_keys(value, {"existed"}, {"sha256"})
        or not isinstance(value.get("existed"), bool)
    ):
        return False
    if not value["existed"]:
        return "sha256" not in value
    sha256 = value.get("sha256")
    return isinstance(sha256, str) and re.fullmatch(r"[0-9a-f]{64}", sha256) is not None


def _valid_keys(value: Mapping[str, Any], required: set[str], optional: set[str]) -> bool:
    keys = set(value)
    return required <= keys <= required | optional


def _valid_public_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    return (
        not posix.is_absolute()
        and not windows.is_absolute()
        and not windows.drive
        and ".." not in posix.parts
        and ".." not in windows.parts
    )


def _validate_tool_registration_receipt(
    value: Mapping[str, Any], definition: Mapping[str, Any]
) -> dict[str, Any]:
    result = dict(value)
    if (
        set(result)
        != {"schemaVersion", "registrationId", "toolId", "definitionFingerprint", "status"}
        or result.get("schemaVersion") != 1
        or result.get("registrationId") != definition.get("registrationId")
        or result.get("toolId") != definition.get("toolId")
        or result.get("status") not in {"registered", "duplicate", "conflict"}
        or not _valid_prefixed_sha256(result.get("definitionFingerprint"))
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 ToolRegistrationReceipt 非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )
    return result


def _validate_tool_call(value: Mapping[str, Any]) -> Mapping[str, Any]:
    if (
        set(value)
        != {
            "schemaVersion",
            "runId",
            "callId",
            "registrationId",
            "toolId",
            "name",
            "argumentsFingerprint",
            "args",
        }
        or value.get("schemaVersion") != 1
        or not all(
            _valid_branded_id(value.get(key))
            for key in ("runId", "callId", "registrationId", "toolId")
        )
        or not isinstance(value.get("name"), str)
        or not value.get("name")
        or not _valid_prefixed_sha256(value.get("argumentsFingerprint"))
        or "args" not in value
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 ToolCall 非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )
    return dict(value)


def _validate_tool_cancel(value: Mapping[str, Any]) -> Mapping[str, Any]:
    if (
        set(value)
        != {"schemaVersion", "runId", "callId", "registrationId", "toolId", "reason"}
        or value.get("schemaVersion") != 1
        or not all(
            _valid_branded_id(value.get(key))
            for key in ("runId", "callId", "registrationId", "toolId")
        )
        or value.get("reason") != "aborted"
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 ToolCancel 非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )
    return dict(value)


def _valid_branded_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 256
        and not any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in value
        )
    )


def _validate_tool_result_receipt(
    value: Mapping[str, Any], request: Mapping[str, Any]
) -> dict[str, Any]:
    result = dict(value)
    if (
        set(result)
        != {"schemaVersion", "resultId", "runId", "callId", "registrationId", "status"}
        or result.get("schemaVersion") != 1
        or any(result.get(key) != request.get(key) for key in ("resultId", "runId", "callId", "registrationId"))
        or result.get("status") not in {"accepted", "duplicate", "conflict", "unknown", "late"}
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 ToolResultReceipt 非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )
    return result


def _valid_prefixed_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[7:])
    )


def _validate_events_page(value: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    result = dict(value)
    events = result.get("events")
    if (
        result.get("schemaVersion") != 1
        or result.get("runId") != run_id
        or not isinstance(result.get("nextCursor"), int)
        or not isinstance(result.get("hasMore"), bool)
        or not isinstance(events, list)
        or not all(isinstance(item, Mapping) for item in events)
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 事件页非法",
            rpc_code=-32600,
            coremind_code="invalid_event_page",
        )
    return result


def _validate_query_result(value: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    result = dict(value)
    if (
        result.get("schemaVersion") != 1
        or result.get("runId") != run_id
        or not isinstance(result.get("derivedFromSequence"), int)
        or not isinstance(result.get("projection"), Mapping)
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 Projection Query 非法",
            rpc_code=-32600,
            coremind_code="invalid_projection_query",
        )
    return result


def _validate_control_receipt(
    value: Mapping[str, Any], command: Mapping[str, Any]
) -> dict[str, Any]:
    result = dict(value)
    if (
        result.get("schemaVersion") != 1
        or result.get("controlId") != command.get("controlId")
        or result.get("runId") != command.get("runId")
        or result.get("status")
        not in {"accepted", "applied", "rejected", "duplicate", "conflict"}
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 ControlReceipt 非法",
            rpc_code=-32600,
            coremind_code="invalid_control_receipt",
        )
    return result


def _validate_run_result(
    value: Mapping[str, Any], *, require_observability: bool = False
) -> dict[str, Any]:
    result = dict(value)
    snapshot = result.get("snapshot")
    required = {
        "schemaVersion",
        "runId",
        "operation",
        "outcome",
        "metrics",
        "evaluation",
        "releaseReadiness",
        "trace",
        "checkpoints",
        "artifacts",
        "extensions",
        "resumable",
    }
    if not isinstance(snapshot, Mapping) or set(snapshot) != required:
        raise ProtocolError(
            "worker 返回的 RunSnapshot 缺失或不符合协议",
            rpc_code=-32600,
            coremind_code="invalid_run_snapshot",
        )
    if snapshot.get("schemaVersion") != 1 or snapshot.get("runId") != result.get("runId"):
        raise ProtocolError(
            "worker 返回的 RunSnapshot 版本或 runId 不一致",
            rpc_code=-32600,
            coremind_code="invalid_run_snapshot",
        )
    if snapshot.get("outcome") != result.get("outcome"):
        raise ProtocolError(
            "worker 返回的 RunSnapshot 与运行终态不一致",
            rpc_code=-32600,
            coremind_code="invalid_run_snapshot",
        )
    if require_observability:
        _validate_observability(result.get("observability"))
    return result


def _validate_observability(value: object) -> None:
    if not isinstance(value, Mapping):
        _raise_invalid_observability()
    telemetry = value.get("telemetry")
    calls = value.get("calls")
    run = value.get("run")
    turns = value.get("turns")
    tools = value.get("tools")
    errors = value.get("errors")
    context = value.get("context")
    artifacts = value.get("artifacts")
    shared_state = value.get("sharedState")
    recovery = value.get("recovery")
    required = {
        "schemaVersion",
        "localEnabled",
        "derivedFromSequence",
        "run",
        "turns",
        "calls",
        "tools",
        "errors",
        "context",
        "artifacts",
        "sharedState",
        "recovery",
        "telemetry",
    }
    if (
        not required.issubset(value)
        or not isinstance(telemetry, Mapping)
        or not isinstance(calls, Mapping)
        or not isinstance(run, Mapping)
        or not isinstance(turns, Mapping)
        or not isinstance(tools, list)
        or not isinstance(errors, list)
        or not isinstance(context, Mapping)
        or not isinstance(artifacts, Mapping)
        or not isinstance(shared_state, Mapping)
        or not isinstance(recovery, Mapping)
    ):
        _raise_invalid_observability()
    if (
        value.get("schemaVersion") != 1
        or value.get("localEnabled") is not True
        or not _is_nonnegative_int(value.get("derivedFromSequence"))
        or not _is_nonnegative_number(calls.get("durationMs"))
        or telemetry.get("mode") not in {"DISABLED", "FEEDBACK_ONLY", "FULL"}
        or telemetry.get("source") not in {"default", "configured", "legacy_default"}
        or telemetry.get("contentLevel") not in {"metrics_only", "content"}
        or not isinstance(telemetry.get("exporterLoaded"), bool)
        or not isinstance(telemetry.get("shutdownTimedOut"), bool)
        or telemetry.get("deliverySemantics") != "best_effort_handoff_not_delivery"
        or not _is_string_list(telemetry.get("allowedFields"))
        or not isinstance(telemetry.get("authorizedScopes"), list)
    ):
        _raise_invalid_observability()
    last_failure = telemetry.get("lastFailure")
    if last_failure is not None and last_failure not in {
        "dns",
        "tls",
        "http_401",
        "http_429",
        "timeout",
        "exporter_failed",
        "exporter_unavailable",
        "egress_policy_missing",
        "egress_policy_denied",
        "configuration_mismatch",
        "feedback_consent_missing",
        "content_consent_missing",
        "redaction_failed",
    }:
        _raise_invalid_observability()
    if (
        run.get("status") not in {"finished", "paused", "interrupted"}
        or not isinstance(run.get("resumable"), bool)
        or (
            "operationState" in run
            and not isinstance(run.get("operationState"), str)
        )
        or (
            "durationMs" in run
            and not _is_nonnegative_number(run.get("durationMs"))
        )
        or not _has_nonnegative_counters(turns, ("started", "completed", "active"))
        or not _has_nonnegative_counters(
            calls, ("started", "completed", "failed", "active")
        )
        or not _has_nonnegative_counters(
            context, ("budgets", "compactions", "failures")
        )
        or not _has_nonnegative_counters(artifacts, ("stored", "blocked"))
        or not _has_nonnegative_counters(shared_state, ("pendingControls",))
        or not isinstance(recovery.get("resumable"), bool)
        or recovery.get("resumable") != run.get("resumable")
        or (
            "operationState" in recovery
            and not isinstance(recovery.get("operationState"), str)
        )
    ):
        _raise_invalid_observability()
    for tool in tools:
        if not _is_tool_lifecycle(tool):
            _raise_invalid_observability()
    for error in errors:
        if (
            not isinstance(error, Mapping)
            or not _is_nonnegative_int(error.get("sequence"))
            or not isinstance(error.get("message"), str)
            or not isinstance(error.get("fatal"), bool)
        ):
            _raise_invalid_observability()
    for counter in ("queued", "handedOff", "failed", "dropped", "duplicates"):
        if not _is_nonnegative_int(telemetry.get(counter)):
            _raise_invalid_observability()
    endpoint_origin = telemetry.get("endpointOrigin")
    if endpoint_origin is not None and not _is_safe_origin(endpoint_origin):
        _raise_invalid_observability()
    for scope in telemetry["authorizedScopes"]:
        if (
            not isinstance(scope, Mapping)
            or not isinstance(scope.get("runId"), str)
            or not isinstance(scope.get("consentId"), str)
            or not _is_sha256(scope.get("scopeFingerprint"))
            or scope.get("kind") not in {"feedback", "content"}
            or not _is_safe_origin(scope.get("targetOrigin"))
            or scope.get("contentLevel") not in {"metrics_only", "content"}
            or not _is_string_list(scope.get("allowedFields"))
            or not isinstance(scope.get("grantedAt"), str)
            or (
                "throughSequence" in scope
                and not _is_nonnegative_int(scope.get("throughSequence"))
            )
            or (
                scope.get("kind") == "feedback"
                and not _is_sha256(scope.get("factPrefixFingerprint"))
            )
            or (
                scope.get("kind") == "content"
                and (
                    not isinstance(scope.get("retentionPurpose"), str)
                    or not scope.get("retentionPurpose")
                    or not isinstance(scope.get("revocationMethod"), str)
                    or not scope.get("revocationMethod")
                )
            )
        ):
            _raise_invalid_observability()


def _raise_invalid_observability() -> None:
    raise ProtocolError(
        "worker 返回的 LocalObservability Projection 不符合协议",
        rpc_code=-32600,
        coremind_code="invalid_observability",
    )


def _is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_nonnegative_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value >= 0
        and value != float("inf")
    )


def _is_string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _has_nonnegative_counters(value: Mapping[str, Any], keys: Sequence[str]) -> bool:
    return all(_is_nonnegative_int(value.get(key)) for key in keys)


_TOOL_PHASES = (
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

_TOOL_RESULT_AXES = {
    "executionOutcome": {"not_invoked", "returned", "threw", "timed_out", "aborted"},
    "effectState": {"not_started", "started", "committed", "unknown"},
    "persistenceState": {"pending", "durable", "failed", "unknown"},
    "recoveryDisposition": {"replay_safe", "requires_proof", "requires_human", "forbidden"},
    "cleanupState": {"not_needed", "pending", "quiescent", "failed"},
    "authorizationState": {"pending", "allowed", "approved", "denied", "expired"},
    "environmentState": {"available", "degraded", "unavailable"},
}

_TOOL_RESULT_AXES_BY_PHASE = {
    "call_recorded": set(),
    "capability_resolved": {"recoveryDisposition", "environmentState"},
    "policy_resolved": {"authorizationState"},
    "approval_resolved": {"authorizationState"},
    "lease_acquired": {"environmentState"},
    "checkpoint_durable": set(),
    "started_durable": {"effectState", "cleanupState"},
    "executing": {"environmentState"},
    "observed": {
        "executionOutcome",
        "effectState",
        "cleanupState",
        "environmentState",
    },
    "result_durable": {"persistenceState"},
    "terminal": {"cleanupState"},
}

_TOOL_RESULT_DEFAULTS = {
    "executionOutcome": "not_invoked",
    "effectState": "not_started",
    "persistenceState": "pending",
    "recoveryDisposition": "requires_human",
    "cleanupState": "not_needed",
    "authorizationState": "pending",
    "environmentState": "available",
}


def _is_tool_lifecycle(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    current_phase = value.get("currentPhase")
    phases = value.get("phases")
    if (
        value.get("version") != 1
        or not _is_nonblank_string(value.get("agent"))
        or not _is_nonblank_string(value.get("callId"))
        or not _is_nonblank_string(value.get("tool"))
        or current_phase not in _TOOL_PHASES
        or not isinstance(value.get("terminal"), bool)
        or value.get("terminal") != (current_phase == "terminal")
        or not isinstance(phases, list)
        or not _is_tool_result(value.get("result"), require_all=True)
        or ("stepId" in value and not _is_nonblank_string(value.get("stepId")))
    ):
        return False
    current_index = _TOOL_PHASES.index(current_phase)
    if len(phases) != current_index + 1:
        return False
    projected_result = dict(_TOOL_RESULT_DEFAULTS)
    for index, resolution in enumerate(phases):
        if not isinstance(resolution, Mapping) or resolution.get("phase") != _TOOL_PHASES[index]:
            return False
        phase = resolution.get("phase")
        status = resolution.get("status")
        if status not in {"completed", "skipped", "failed"}:
            return False
        if phase in {"call_recorded", "terminal"} and status != "completed":
            return False
        if status != "completed":
            reason = resolution.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                return False
        result_patch = resolution.get("result")
        if "result" in resolution:
            if not _is_tool_result(result_patch, require_all=False):
                return False
            if any(axis not in _TOOL_RESULT_AXES_BY_PHASE[phase] for axis in result_patch):
                return False
            next_effect = result_patch.get("effectState")
            if next_effect is not None and not _can_transition_effect_state(
                projected_result["effectState"], next_effect
            ):
                return False
            next_execution = result_patch.get("executionOutcome")
            if (
                next_execution is not None
                and projected_result["executionOutcome"] != "not_invoked"
                and next_execution != projected_result["executionOutcome"]
            ):
                return False
            projected_result.update(result_patch)
    return dict(value["result"]) == projected_result


def _is_tool_result(value: object, *, require_all: bool) -> bool:
    if not isinstance(value, Mapping):
        return False
    if require_all and set(value) != set(_TOOL_RESULT_AXES):
        return False
    return all(
        axis in _TOOL_RESULT_AXES and item in _TOOL_RESULT_AXES[axis]
        for axis, item in value.items()
    )


def _can_transition_effect_state(previous: object, next_value: object) -> bool:
    if previous == "not_started":
        return True
    if previous == "started":
        return next_value in {"started", "committed", "unknown"}
    if previous == "committed":
        return next_value == "committed"
    return previous == "unknown" and next_value == "unknown"


def _is_nonblank_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _is_safe_origin(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.netloc)
        and parsed.username is None
        and parsed.password is None
        and value == f"{parsed.scheme}://{parsed.netloc}"
    )


def _discover_worker_command() -> list[str]:
    explicit = os.environ.get("COREMIND_WORKER_PATH")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    package_root = Path(__file__).resolve().parent
    candidates.append(package_root / "_worker" / "coremind-worker.mjs")
    repository_root = package_root.parents[2] if len(package_root.parents) > 2 else package_root
    candidates.append(repository_root / "packages" / "coremind-worker" / "dist" / "stdio.js")
    node = shutil.which("node")
    for candidate in candidates:
        if candidate.is_file():
            if not node:
                raise WorkerNotFoundError("已找到 worker，但系统 PATH 中没有 Node.js 22.19+")
            return [node, str(candidate)]
    executable = shutil.which("coremind-worker")
    if executable:
        return [executable]
    raise WorkerNotFoundError(
        "找不到 CoreMind Node worker。请安装随 PyPI 包提供的 worker，或设置 COREMIND_WORKER_PATH"
    )


def _verify_bundled_worker(command: Sequence[str]) -> None:
    """启动随 wheel 分发的 Worker 前校验版本、协议与内容摘要。"""

    if len(command) < 2:
        return
    worker = Path(command[1]).resolve()
    bundled = Path(__file__).resolve().parent / "_worker" / "coremind-worker.mjs"
    if worker != bundled.resolve():
        return
    manifest_path = bundled.with_name("manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        actual_sha256 = hashlib.sha256(bundled.read_bytes()).hexdigest()
    except (OSError, ValueError) as error:
        raise WorkerNotFoundError(f"无法校验随包 Worker：{error}") from error

    from . import __version__

    if manifest.get("version") != __version__:
        raise WorkerNotFoundError(
            f"随包 Worker 版本漂移：SDK={__version__}，Worker={manifest.get('version')}"
        )
    if manifest.get("protocolVersion") != PROTOCOL_VERSION:
        raise WorkerNotFoundError(
            f"随包 Worker 协议漂移：SDK={PROTOCOL_VERSION}，Worker={manifest.get('protocolVersion')}"
        )
    if manifest.get("bundleSha256") != actual_sha256:
        raise WorkerNotFoundError("随包 Worker 内容摘要不匹配；请重新安装 coremind-ai")


def _validate_v2_initialize_result(value: Mapping[str, Any]) -> None:
    """校验 Node Runtime 身份、迁移窗口与精确 v2 Schema 指纹。"""

    manifest_path = Path(__file__).resolve().parent / "_worker" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise WorkerNotFoundError(f"无法读取随包 Worker 清单：{error}") from error
    expected = manifest.get("protocolV2SchemaFingerprint")
    if value.get("schemaFingerprint") != expected:
        raise ProtocolError(
            "Protocol v2 Schema 指纹不匹配",
            rpc_code=-32000,
            coremind_code="protocol_version_mismatch",
        )
    migration = value.get("migration")
    warnings = value.get("warnings")
    if (
        manifest.get("protocolV2Version") != PROTOCOL_V2_VERSION
        or value.get("runtime") != "node"
        or not isinstance(warnings, list)
        or not all(isinstance(warning, str) for warning in warnings)
        or not isinstance(migration, Mapping)
        or migration.get("v1Supported") is not True
        or migration.get("v1SupportedThrough") != "0.4.x"
        or migration.get("earliestRemoval") != "0.5.0"
    ):
        raise ProtocolError(
            "worker 返回的 Protocol v2 初始化身份或迁移窗口非法",
            rpc_code=-32600,
            coremind_code="protocol_validation_failed",
        )


def _schema_from_callable(function: Callable[..., Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, parameter in inspect.signature(function).parameters.items():
        if parameter.kind in {parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD}:
            raise CoreMindError(f"Python 工具 {function.__name__} 不支持 *args/**kwargs")
        properties[name] = _annotation_schema(parameter.annotation)
        if parameter.default is inspect.Parameter.empty:
            required.append(name)
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def _normalize_tool_effect(effect: Mapping[str, Any]) -> dict[str, Any]:
    """校验并复制工具副作用声明，避免把不可证明的权限信息发送给 worker。"""

    allowed = {"read", "write", "process", "network", "external"}
    operations = effect.get("operations")
    reversible = effect.get("reversible")
    if (
        not isinstance(operations, list)
        or not operations
        or any(operation not in allowed for operation in operations)
        or not isinstance(reversible, bool)
    ):
        raise CoreMindError("Python 工具必须提供有效 effect 副作用声明")
    normalized: dict[str, Any] = {
        "operations": list(dict.fromkeys(operations)),
        "reversible": reversible,
    }
    for field in ("pathFields", "urlFields"):
        value = effect.get(field)
        if value is None:
            continue
        if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
            raise CoreMindError(f"Python 工具 effect.{field} 必须是非空字符串数组")
        normalized[field] = list(value)
    return normalized


def _annotation_schema(annotation: Any) -> dict[str, Any]:
    if annotation is inspect.Parameter.empty or annotation is Any:
        return {}
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin in {Union, UnionType} and type(None) in args:
        non_null = [item for item in args if item is not type(None)]
        return _annotation_schema(non_null[0]) if len(non_null) == 1 else {}
    if annotation is str:
        return {"type": "string"}
    if annotation is bool:
        return {"type": "boolean"}
    if annotation is int:
        return {"type": "integer"}
    if annotation is float:
        return {"type": "number"}
    if origin in {list, tuple, set}:
        return {"type": "array", "items": _annotation_schema(args[0]) if args else {}}
    if origin is dict or annotation is dict:
        return {"type": "object"}
    return {}
