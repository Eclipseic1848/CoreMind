"""CoreMind Python SDK 公共入口。"""

from .client import AsyncCoreMindClient, CoreMindClient, McpAuthHandler, parse_mcp_auth_request, parse_verification_request
from .errors import (
    ERROR_CODES,
    CoreMindError,
    ProtocolError,
    WorkerExitedError,
    WorkerNotFoundError,
    error_code_info,
)

__all__ = [
    "AsyncCoreMindClient",
    "CoreMindClient",
    "CoreMindError",
    "ERROR_CODES",
    "ProtocolError",
    "WorkerExitedError",
    "WorkerNotFoundError",
    "error_code_info",
    "parse_verification_request",
    "parse_mcp_auth_request",
    "McpAuthHandler",
]

__version__ = "1.1.0"  # x-release-please-version
