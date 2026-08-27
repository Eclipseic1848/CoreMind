"""CoreMind Python SDK 的稳定错误类型。"""

from __future__ import annotations

import json
from pathlib import Path
from types import MappingProxyType
from typing import Mapping


ErrorCodeInfo = Mapping[str, str]


def _load_error_codes() -> Mapping[str, ErrorCodeInfo]:
    contract_path = Path(__file__).with_name("_error_contract.json")
    with contract_path.open("r", encoding="utf-8") as source:
        contract = json.load(source)
    codes = contract.get("codes")
    if contract.get("schemaVersion") != 1 or not isinstance(codes, dict):
        raise RuntimeError("CoreMind Python Error Contract 无效")
    if any(not isinstance(info, dict) for info in codes.values()):
        raise RuntimeError("CoreMind Python Error Contract 分类项无效")
    return MappingProxyType(
        {
            str(code): MappingProxyType({str(key): str(value) for key, value in info.items()})
            for code, info in codes.items()
        }
    )


ERROR_CODES: Mapping[str, ErrorCodeInfo] = _load_error_codes()


def error_code_info(code: str | None) -> ErrorCodeInfo | None:
    """查询由唯一 Error Contract 派生的稳定分类。"""

    return ERROR_CODES.get(code) if code is not None else None


def _normalize_error_code(code: str | None) -> tuple[str | None, str | None]:
    if code is None or code in ERROR_CODES:
        return code, None
    return "unclassified_error", code


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
        normalized_code, original_code = _normalize_error_code(coremind_code)
        self.rpc_code = rpc_code
        self.coremind_code = normalized_code
        self.original_coremind_code = original_code
        self.details = details
        self.error_info = error_code_info(normalized_code)
