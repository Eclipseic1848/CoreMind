"""2.0.0 记忆网关示例的兼容入口。"""

from pathlib import Path
import sys

# 原示例入口在源码检出中继续可用，独立部署使用 wheel 的控制台命令。
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/memory/src"))

from coremind_memory_mcp.server import (
    Bank, BankTarget, Bindings, Conflict, Grant, MemoryService, Reflection,
    RequestBody, Target, Write, main, make_app,
)

if __name__ == "__main__":
    main()
