"""CoreMind 常驻 Node worker 客户端。"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import queue
import shutil
import subprocess
import threading
from collections import deque
from pathlib import Path
from types import UnionType
from typing import Any, Callable, Mapping, Sequence, Union, get_args, get_origin

from .errors import CoreMindError, ProtocolError, WorkerExitedError, WorkerNotFoundError

PROTOCOL_VERSION = "1.0"
ApprovalHandler = Callable[[Mapping[str, Any]], str]
EventHandler = Callable[[Mapping[str, Any]], None]


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
    ) -> None:
        self._config = config
        self._config_dir = Path(config_dir).resolve() if config_dir else None
        self._cwd = Path(cwd).resolve() if cwd else None
        self._session_id = session_id
        self._worker_command = list(worker_command) if worker_command else None
        self._event_handler = event_handler
        self._approval_handler = approval_handler
        self._request_timeout = request_timeout
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
        self._tools: dict[str, tuple[Callable[..., Any], dict[str, Any]]] = {}
        self.events: list[Mapping[str, Any]] = []

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
                result = self._request_raw("initialize", self._initialize_params())
                if result.get("protocolVersion") != PROTOCOL_VERSION:
                    raise ProtocolError(
                        f"协议版本不匹配：SDK={PROTOCOL_VERSION}，worker={result.get('protocolVersion')}",
                        rpc_code=-32000,
                        coremind_code="protocol_version_mismatch",
                    )
                if "runSnapshot" not in result.get("capabilities", []):
                    raise ProtocolError(
                        "worker 不支持当前 SDK 要求的 RunSnapshot 能力",
                        rpc_code=-32000,
                        coremind_code="protocol_capability_missing",
                    )
                for spec in self._tools.values():
                    self._register_tool_spec(spec[1])
            except BaseException:
                self._terminate_process()
                self._process = None
                raise
            self._started = True
            return self

    def run(self, input: str | None = None) -> dict[str, Any]:
        """执行一次 Run，返回与 TypeScript SDK 等价的 JSON 结果。"""

        self.start()
        return _validate_run_result(
            self._request_raw("run", {"input": input} if input is not None else {})
        )

    def chat(self, message: str, *, agent: str = "main") -> dict[str, Any]:
        """在常驻 worker 中发起一次聊天请求。"""

        self.start()
        return _validate_run_result(
            self._request_raw("chat", {"agent": agent, "message": message})
        )

    def cancel(self, run_id: str) -> None:
        """取消指定的活动运行。"""

        self.start()
        self._request_raw("cancel", {"runId": run_id})

    def inspect_run(self, run_id: str) -> dict[str, Any]:
        """读取 append-only RunState、完成状态与 checkpoint 列表。"""

        self.start()
        return dict(self._request_raw("inspect_run", {"runId": run_id}))

    def resume_run(self, run_id: str, *, input: str | None = None) -> dict[str, Any]:
        """从意外中断或显式暂停运行的最近稳定边界继续执行。"""

        self.start()
        params: dict[str, Any] = {"runId": run_id}
        if input is not None:
            params["input"] = input
        return _validate_run_result(self._request_raw("resume_run", params))

    def checkpoint_diff(self, run_id: str, checkpoint_id: str) -> dict[str, Any]:
        """比较 checkpoint 前内容与当前工作区文件。"""

        self.start()
        return dict(
            self._request_raw(
                "checkpoint_diff", {"runId": run_id, "checkpointId": checkpoint_id}
            )
        )

    def checkpoint_restore(
        self, run_id: str, checkpoint_id: str, *, confirm: bool
    ) -> dict[str, Any]:
        """在调用方显式 confirm=True 后恢复可逆 checkpoint。"""

        if confirm is not True:
            raise CoreMindError("恢复 checkpoint 必须显式传入 confirm=True")
        self.start()
        return dict(
            self._request_raw(
                "checkpoint_restore",
                {"runId": run_id, "checkpointId": checkpoint_id, "confirm": True},
            )
        )

    def tool(
        self,
        *,
        effect: Mapping[str, Any],
        name: str | None = None,
        description: str | None = None,
        parameters: Mapping[str, Any] | None = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """把同步或异步 Python callable 注册为 Agent 工具。"""

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

    def close(self) -> None:
        """关闭 worker；可重复调用。"""

        with self._lifecycle_lock:
            if self._closed:
                return
            if self._process and self._process.poll() is None:
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
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
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
        if not isinstance(params, Mapping):
            return
        if method == "event":
            self.events.append(params)
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

    def _answer_approval(
        self,
        params: Mapping[str, Any],
        event: Mapping[str, Any],
    ) -> None:
        try:
            decision = self._approval_handler(event) if self._approval_handler else "deny"
            if decision not in {"allow", "deny"}:
                decision = "deny"
            self._request_raw(
                "approve",
                {
                    "runId": params["runId"],
                    "approvalId": event["approvalId"],
                    "decision": decision,
                },
            )
        except CoreMindError:
            return

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

    async def run(self, input: str | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.run, input)

    async def chat(self, message: str, *, agent: str = "main") -> dict[str, Any]:
        return await asyncio.to_thread(self._client.chat, message, agent=agent)

    async def cancel(self, run_id: str) -> None:
        await asyncio.to_thread(self._client.cancel, run_id)

    async def inspect_run(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.inspect_run, run_id)

    async def resume_run(self, run_id: str, *, input: str | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.resume_run, run_id, input=input)

    async def checkpoint_diff(self, run_id: str, checkpoint_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._client.checkpoint_diff, run_id, checkpoint_id)

    async def checkpoint_restore(
        self, run_id: str, checkpoint_id: str, *, confirm: bool
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._client.checkpoint_restore,
            run_id,
            checkpoint_id,
            confirm=confirm,
        )

    async def close(self) -> None:
        await asyncio.to_thread(self._client.close)

    async def __aenter__(self) -> "AsyncCoreMindClient":
        return await self.start()

    async def __aexit__(self, _type: object, _value: object, _traceback: object) -> None:
        await self.close()


def _validate_run_result(value: Mapping[str, Any]) -> dict[str, Any]:
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
    return result


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
