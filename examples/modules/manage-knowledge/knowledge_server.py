"""保留源码使用方的入口，复用独立知识组件。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/knowledge/src"))

from coremind_knowledge_mcp.server import load_corpus, main as serve, make_app


def main():
    manifest = Path(__file__).resolve().parents[2] / "knowledge-evals/zh-retrieval/manifest.json"
    serve(legacy_manifest=manifest)


if __name__ == "__main__":
    main()
