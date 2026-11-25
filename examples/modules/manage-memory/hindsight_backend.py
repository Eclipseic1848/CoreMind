"""2.0.0 Hindsight 后端示例的兼容入口。"""

from pathlib import Path
import sys

# 原示例入口在源码检出中继续可用，独立部署使用 wheel 的控制台命令。
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/memory/src"))

from coremind_memory_mcp.backend import HindsightBackend
