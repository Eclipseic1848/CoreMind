"""从本地资料建索引，向获准的 CoreMind 运行提供只读知识查询。"""

import argparse
import hmac
import json
import os
from datetime import date
from pathlib import Path
from typing import Annotated

import uvicorn
from markdown_it import MarkdownIt
from mcp.server.fastmcp import FastMCP
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import __version__
from .catalog import KnowledgeCatalog
from .text import terms


def load_corpus(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    as_of = date.fromisoformat(manifest["asOf"]).isoformat()
    directory = (manifest_path.parent / "sources").resolve(strict=True)
    records = []
    seen = set()
    for source in manifest["documents"]:
        file = source["file"]
        if not file or Path(file).name != file or ":" in file or "/" in file or "\\" in file:
            raise ValueError("来源文件必须是 sources 目录下的文件名")
        path = (directory / file).resolve(strict=True)
        if path.parent != directory or not path.is_file():
            raise ValueError(f"来源文件超出资料目录：{file}")
        start = date.fromisoformat(source["validFrom"]).isoformat()
        until = source["validUntil"]
        if until is not None:
            until = date.fromisoformat(until).isoformat()
            if start >= until:
                raise ValueError(f"来源有效期无效：{file}")
        version = source["version"]
        doc_id = source["id"]
        if not isinstance(doc_id, str) or not doc_id.strip() or type(version) is not int or version < 1:
            raise ValueError(f"来源 ID 或版本无效：{file}")
        if (doc_id, version) in seen:
            raise ValueError(f"来源 ID 与版本重复：{file}")
        seen.add((doc_id, version))
        access = source["access"]
        if not isinstance(access, str) or not access.strip() or access != access.strip():
            raise ValueError(f"来源范围无效：{file}")
        metadata = {}
        if path.suffix.lower() == ".md":
            lines = path.read_text(encoding="utf-8").splitlines()
            items = [
                {"text": content.strip(), "line": line}
                for line, content in enumerate(lines, 1)
                if next(terms(content), None) is not None
            ]
            headers = {}
            for token in MarkdownIt("commonmark").enable("table").parse("\n".join(lines)):
                if token.type == "table_open":
                    header_index, table_end = token.map
                    # 第一个数据行在表头和分隔行之后；保留原始行号与原文。
                    header = {"line": header_index + 1, "text": lines[header_index]}
                    for number in range(header_index + 3, table_end + 1):
                        headers[str(number)] = header
            metadata["tableHeaders"] = headers
        elif path.suffix.lower() in {".pdf", ".docx"}:
            try:
                from .docling_bridge import parse_document
            except ModuleNotFoundError as exc:
                if exc.name != "docling":
                    raise
                raise ValueError("处理 PDF 或 DOCX 需要安装知识组件的 documents 扩展") from exc

            items = parse_document(path)
        else:
            raise ValueError(f"不支持的资料格式：{file}")
        if not items:
            raise ValueError(f"资料未提取出正文：{file}")
        records.append(
            {
                "docId": doc_id,
                "version": version,
                "file": file,
                "access": access,
                "validFrom": start,
                "validUntil": until,
                "chunks": items,
                **metadata,
            }
        )
    return as_of, records


def make_app(catalog, scope, as_of, token):
    mcp = FastMCP("CoreMind Knowledge", stateless_http=True, json_response=True)

    @mcp.tool(structured_output=False)
    def search_knowledge(query: Annotated[str, Field(min_length=1, max_length=500)]) -> str:
        """查找可参考的资料片段并附版本与来源位置。相似片段只是候选证据。表格行按 tableHeader 解释列值，引用数据行。"""
        if not query.strip():
            raise ValueError("查询不能为空")
        matches = catalog.search(query.strip(), scope=scope, as_of=as_of, limit=5, mode="sparse")
        fields = {"docId", "version", "file", "line", "locator", "chunkId", "text", "tableHeader"}
        citations = [{key: value for key, value in row.items() if key in fields} for row in matches]
        return json.dumps({"citations": citations}, ensure_ascii=False)

    @mcp.tool(structured_output=False)
    def resolve_citation(
        docId: Annotated[str, Field(min_length=1, max_length=200)],
        version: Annotated[int, Field(ge=1)],
        file: Annotated[str, Field(min_length=1, max_length=200)],
        line: Annotated[int | None, Field(ge=1)] = None,
        locator: Annotated[str | None, Field(max_length=200)] = None,
        chunkId: Annotated[int | None, Field(ge=1)] = None,
    ) -> str:
        """回查原文。使用检索返回的 chunkId 或 Markdown 行号。旧位置匹配多段时报告歧义。"""
        return json.dumps(
            catalog.resolve(
                docId.strip(), version, file, line=line, locator=locator,
                scope=scope, as_of=as_of, chunk_id=chunkId,
            ),
            ensure_ascii=False,
        )

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request):
        return JSONResponse({"status": "ready"})

    app = mcp.streamable_http_app()

    async def authorized(asgi_scope, receive, send):
        if asgi_scope["type"] == "http":
            request = Request(asgi_scope, receive)
            actual = request.headers.get("authorization", "").encode("utf-8")
            if not hmac.compare_digest(actual, token):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(
                    asgi_scope, receive, send
                )
                return
        await app(asgi_scope, receive, send)

    return authorized


def main(*, legacy_manifest=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--manifest", type=Path, default=legacy_manifest, required=legacy_manifest is None)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--scope", default="public", required=legacy_manifest is None)
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--state", type=Path, required=legacy_manifest is None)
    parser.add_argument(
        "--withdraw",
        action="append",
        default=[],
        metavar="DOC:VERSION",
        help="启动时撤回指定文档版本，可重复",
    )
    args = parser.parse_args()
    if not args.scope.strip() or args.scope != args.scope.strip():
        parser.error("--scope 需要非空的阅读范围")
    authorization = os.environ.get("COREMIND_KNOWLEDGE_AUTHORIZATION", "")
    if not authorization.startswith("Bearer ") or len(authorization.removeprefix("Bearer ").strip()) < 24:
        parser.error("请通过 COREMIND_KNOWLEDGE_AUTHORIZATION 提供独立的本地 Bearer 令牌")
    if args.state is not None:
        sources = (args.manifest.parent / "sources").resolve()
        for output in (args.state, args.state.with_suffix(args.state.suffix + ".tmp")):
            target = output.resolve()
            if target == args.manifest.resolve() or target.is_relative_to(sources) or target.is_relative_to(args.model_dir.resolve()):
                parser.error("--state 必须与清单、来源目录和模型目录分开")
    withdrawals = []
    for item in args.withdraw:
        doc_id, separator, version = item.rpartition(":")
        if not separator or not doc_id.strip() or not version.isascii() or not version.isdigit() or int(version) < 1:
            parser.error("--withdraw 需要 DOC:VERSION，版本必须为正整数")
        withdrawals.append((doc_id.strip(), int(version)))
    from .retrieval import KnowledgeIndex

    as_of, records = load_corpus(args.manifest)
    index = KnowledgeIndex(args.model_dir)
    try:
        catalog = KnowledgeCatalog(index, args.state)
        catalog.import_documents(records, withdrawals=withdrawals)
        uvicorn.run(
            make_app(catalog, args.scope, as_of, authorization.encode("utf-8")),
            host="127.0.0.1",
            port=args.port,
            access_log=False,
        )
    finally:
        index.close()


if __name__ == "__main__":
    main()
