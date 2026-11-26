"""在本地通过 MCP 提供可选本体查询、校验和动作。"""

import argparse
import hmac
import json
import os
import runpy
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Literal

import uvicorn
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Match


Identifier = Annotated[str, Field(min_length=1, max_length=512)]
ActionIdentifier = Annotated[str, Field(min_length=1, max_length=128)]
RECONCILE_PATH = "/admin/reconcile-action"


class Reconciliation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    requestId: ActionIdentifier
    resource: Identifier
    previousState: str
    status: Literal["completed", "failed"]
    state: str


def make_app(project, read_token, action_token=None, *, reconcile_token=None):
    if reconcile_token is not None and any(
        token is not None and hmac.compare_digest(reconcile_token, token)
        for token in (read_token, action_token)
    ):
        raise ValueError("本体对账须使用独立的宿主令牌")
    mcp = FastMCP("CoreMind Ontology", stateless_http=True, json_response=True)

    def invoke(method, *args):
        result = {"status": "unavailable", "reason": "ontology_unavailable"}
        if project is not None:
            try:
                result = getattr(project, method)(*args)
            except Exception:
                if method == "perform_action":
                    result = {"status": "unknown", "reason": "effect_not_confirmed", "requestId": args[-1]}
        return result

    @mcp.tool(structured_output=False)
    def ontology_describe(resource: Identifier) -> str:
        """查询对象类型、属性和出向关系，并附模型版本和摘要。"""
        return json.dumps(invoke("describe", resource), ensure_ascii=False)

    @mcp.tool(structured_output=False)
    def ontology_validate_record(source: ActionIdentifier, record: dict) -> str:
        """将源记录按业务映射校验，返回约束项或待人工确认的问题。"""
        return json.dumps(invoke("validate_record", source, record), ensure_ascii=False)

    @mcp.tool(structured_output=False)
    def ontology_inspect_action(action: ActionIdentifier, resource: Identifier) -> str:
        """检查业务动作的前置条件并生成候选，不执行动作。"""
        return json.dumps(invoke("inspect_action", action, resource), ensure_ascii=False)

    @mcp.tool(structured_output=False)
    def ontology_perform_action(
        action: ActionIdentifier, resource: Identifier, request_id: ActionIdentifier, ctx: Context
    ) -> CallToolResult:
        """在宿主授权下执行具体业务动作，由业务回执决定动作状态。"""
        request = ctx.request_context.request
        actual = request.headers.get("authorization", "").encode("utf-8") if request else b""
        if action_token is None or not hmac.compare_digest(actual, action_token):
            result = {"status": "denied", "reason": "action_not_authorized"}
        else:
            result = invoke("perform_action", action, resource, request_id)
        return CallToolResult(
            content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
            isError=result["status"] == "unknown",
        )

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request):
        return JSONResponse({"status": "ready" if project is not None else "unavailable"})

    @mcp.custom_route(RECONCILE_PATH, methods=["POST"])
    async def reconcile(request):
        try:
            receipt = Reconciliation.model_validate(await request.json())
        except (ValidationError, ValueError):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        if project is None:
            return JSONResponse({"status": "unavailable", "reason": "ontology_unavailable"}, status_code=503)
        try:
            result = await run_in_threadpool(project.reconcile_action, receipt.model_dump())
        except Exception:
            return JSONResponse({"status": "unavailable", "reason": "ontology_unavailable"}, status_code=503)
        if result["status"] == "unavailable":
            return JSONResponse(result, status_code=503)
        if result["status"] == "denied":
            return JSONResponse(result, status_code=404 if result["reason"] == "request_not_found" else 409)
        return JSONResponse(result)

    app = mcp.streamable_http_app()
    reconcile_route = next(route for route in app.routes if route.path == RECONCILE_PATH)

    async def authorized(scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope, receive)
            actual = request.headers.get("authorization", "").encode("utf-8")
            match, _ = reconcile_route.matches(scope)
            tokens = (read_token, action_token) if match is Match.NONE else (reconcile_token,)
            if not any(token is not None and hmac.compare_digest(actual, token) for token in tokens):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await app(scope, receive, send)

    return authorized


def main(*, demo_executor=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=version("coremind-ontology-mcp") if demo_executor is None else "source-example")
    parser.add_argument("--model-dir", type=Path, required=True, help="业务本体模型目录")
    parser.add_argument("--port", type=int, default=8879)
    parser.add_argument("--receipt-db", type=Path, help="工作区外或业务持久目录中的 SQLite 回执库")
    handlers = parser.add_mutually_exclusive_group()
    handlers.add_argument("--action-handler", type=Path, help="经宿主审阅的 Python 文件，提供 execute(command)")
    if demo_executor is not None:
        handlers.add_argument("--enable-actions", action="store_true", help="使用源码示例的合成处理器")
    args = parser.parse_args()

    def token(name):
        value = os.environ.get(name, "")
        bearer = value.removeprefix("Bearer ")
        if value == bearer or len(bearer) < 24 or any(char.isspace() for char in bearer):
            parser.error(f"请通过 {name} 提供独立的本地 Bearer 令牌")
        return value.encode("utf-8")

    read_token = token("COREMIND_ONTOLOGY_AUTHORIZATION")
    demo = getattr(args, "enable_actions", False)
    if args.action_handler and not args.receipt_db:
        parser.error("业务动作需要 --receipt-db，以保留未决回执")
    action_token = token("COREMIND_ONTOLOGY_ACTION_AUTHORIZATION") if args.action_handler or demo else None
    if action_token is not None and hmac.compare_digest(read_token, action_token):
        parser.error("本体动作与只读查询需要使用不同令牌")
    reconcile_ref = "COREMIND_ONTOLOGY_RECONCILE_AUTHORIZATION"
    reconcile_token = token(reconcile_ref) if os.environ.get(reconcile_ref) else None
    if reconcile_token is not None:
        if args.receipt_db is None:
            parser.error("宿主对账需要 --receipt-db，以读取和提交原请求回执")
        if any(value is not None and hmac.compare_digest(reconcile_token, value)
               for value in (read_token, action_token)):
            parser.error("本体对账须使用独立的宿主令牌")
    from .project import OntologyProject
    executor = demo_executor if demo else None
    if args.action_handler:
        executor = runpy.run_path(str(args.action_handler.resolve(strict=True))).get("execute")
        if not callable(executor):
            parser.error("业务处理器须提供可调用的 execute(command)")
    try:
        project = OntologyProject(args.model_dir, executor=executor, receipt_db=args.receipt_db)
    except Exception:
        # 保留目录与错误回执，避免启动错误向模型暴露路径或业务数据。
        if args.receipt_db:
            parser.error("模型或回执库不可用，请核对模型、目录权限及服务是否已停止")
        project = None
    try:
        uvicorn.run(
            make_app(project, read_token, action_token, reconcile_token=reconcile_token),
            host="127.0.0.1",
            port=args.port,
            proxy_headers=False,
            access_log=False,
            use_colors=False,
        )
    finally:
        if project is not None:
            project.close()


if __name__ == "__main__":
    main()
