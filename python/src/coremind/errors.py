"""CoreMind Python SDK 的稳定错误类型。"""


class CoreMindError(RuntimeError):
    """Python SDK 基础错误。"""


class WorkerNotFoundError(CoreMindError):
    """找不到 Node worker 或 Node.js。"""


class WorkerExitedError(CoreMindError):
    """Node worker 意外退出。"""


class ProtocolError(CoreMindError):
    """CoreMind Protocol 返回的结构化错误。"""

    def __init__(
        self,
        message: str,
        *,
        rpc_code: int,
        coremind_code: str | None = None,
        details: object | None = None,
    ):
        super().__init__(message)
        self.rpc_code = rpc_code
        self.coremind_code = coremind_code
        self.details = details
