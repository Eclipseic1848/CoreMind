"""让源码示例复用同一组件实现；已安装的服务无需此入口。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/ontology/src"))
