"""在本地通过 MCP 提供可选本体查询、校验和动作。"""

import argparse
import hmac
import json
import os
from pathlib import Path
from typing import Annotated

import uvicorn
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse


Identifier = Annotated[str, Field(min_length=1, max_length=512)]
ActionIdentifier = Annotated[str, Field(min_length=1, max_length=128)]


def make_app(project, read_token, action_token=None):
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

    app = mcp.streamable_http_app()

    async def authorized(scope, receive, send):
        if scope["type"] == "http":
            actual = Request(scope, receive).headers.get("authorization", "").encode("utf-8")
            if not hmac.compare_digest(actual, read_token) and (
                action_token is None or not hmac.compare_digest(actual, action_token)
            ):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await app(scope, receive, send)

    return authorized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True, help="业务本体模型目录")
    parser.add_argument("--port", type=int, default=8879)
    parser.add_argument("--enable-actions", action="store_true", help="启用合成业务动作执行器")
    args = parser.parse_args()

    def token(name):
        value = os.environ.get(name, "")
        bearer = value.removeprefix("Bearer ")
        if value == bearer or len(bearer) < 24 or any(char.isspace() for char in bearer):
            parser.error(f"请通过 {name} 提供独立的本地 Bearer 令牌")
        return value.encode("utf-8")

    read_token = token("COREMIND_ONTOLOGY_AUTHORIZATION")
    action_token = token("COREMIND_ONTOLOGY_ACTION_AUTHORIZATION") if args.enable_actions else None
    if action_token is not None and hmac.compare_digest(read_token, action_token):
        parser.error("本体动作与只读查询需要使用不同令牌")
    try:
        from ontology_project import OntologyProject, demo_transition

        project = OntologyProject(args.model_dir, executor=demo_transition if args.enable_actions else None)
    except Exception:
        # 保留目录与错误回执，避免启动错误向模型暴露路径或业务数据。
        project = None
    uvicorn.run(
        make_app(project, read_token, action_token),
        host="127.0.0.1",
        port=args.port,
        proxy_headers=False,
        access_log=False,
        use_colors=False,
    )


if __name__ == "__main__":
    main()
