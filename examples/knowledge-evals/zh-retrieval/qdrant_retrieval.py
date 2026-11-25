"""保留源码使用方的入口，复用独立知识组件。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/knowledge/src"))

from coremind_knowledge_mcp.retrieval import (
    MODEL_FILES, MODEL_REPO, MODEL_REVISION, KnowledgeIndex, ordinal, verify_model,
)
