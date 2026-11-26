"""以 CoreMind 的宿主授权连接本地 Hindsight。"""

import argparse
import hashlib
import hmac
import json
import os
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
from typing import Annotated, Literal

import uvicorn
from . import __version__
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse

Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")]
Query = Annotated[str, Field(min_length=1, max_length=2000)]


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Bank(RequestBody):
    kind: Literal["personal", "project", "team", "branch"]


class Grant(RequestBody):
    tokenEnv: Identifier
    banks: Annotated[list[Identifier], Field(min_length=1, max_length=8)]


class Bindings(RequestBody):
    banks: dict[Identifier, Bank]
    readers: list[Grant]
    administrators: list[Grant]


class BankTarget(RequestBody):
    bankId: Identifier


class Target(BankTarget):
    documentId: Identifier


class EvidenceRef(RequestBody):
    documentId: Identifier
    version: Annotated[int, Field(ge=1, strict=True)]


class Write(Target):
    expectedVersion: Annotated[int, Field(ge=0, strict=True)] = 0
    text: Annotated[str, Field(min_length=1, max_length=2000)]
    source: Annotated[str, Field(min_length=1, max_length=250)]
    occurredAt: date
    expiresAt: date | None = None
    kind: Literal["fact", "experience"] = "fact"
    evidence: Annotated[list[EvidenceRef], Field(min_length=1)] | None = None


class Reflection(RequestBody):
    bankId: Identifier
    query: Query


class Conflict(ValueError):
    pass


class MemoryService:
    def __init__(self, backend, state_path):
        self.backend = backend
        self.state_path = state_path
        self.lock = RLock()
        self.records = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}

    def _save(self, changes):
        new_state = {**self.records, **changes}
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.state_path.parent, delete=False
        ) as file:
            temp = Path(file.name)
            try:
                json.dump(new_state, file, ensure_ascii=False, sort_keys=True)
                file.flush()
                os.fsync(file.fileno())
            except BaseException:
                file.close()
                temp.unlink(missing_ok=True)
                raise
        try:
            temp.replace(self.state_path)
        finally:
            temp.unlink(missing_ok=True)
        self.records = new_state

    @staticmethod
    def _key(bank, document):
        return f"{bank}/{document}"

    def _dependent_reviews(self, bank, doc, previous):
        if not previous or "version" not in previous:
            return {}
        by_source = defaultdict(list)
        for key, receipt in self.records.items():
            if key.startswith(f"{bank}/") and receipt["state"] in {"active", "pending"}:
                for ref in receipt.get("evidence", []):
                    by_source[ref["documentId"], ref["version"]].append(key)
        sources = [(doc, previous["version"])]
        changes = {}
        for source in sources:
            for key in by_source[source]:
                if key not in changes:
                    receipt = self.records[key]
                    changes[key] = {**receipt, "state": "pending_review"}
                    sources.append((key.split("/", 1)[1], receipt["version"]))
        return changes

    def _evidence_expiry(self, bank, doc, evidence, changes, expiry):
        active = self._active(bank)
        expiries = [expiry] if expiry else []
        for ref in evidence:
            source = ref["documentId"]
            key = self._key(bank, source)
            if source == doc or key in changes:
                raise Conflict("经验不能引用自身或随本次更正失效的下游")
            if active.get(source) != ref["version"]:
                raise Conflict("经验依据必须是同一记忆库中的有效版本")
            source_expiry = self.records[key]["expiresAt"]
            if source_expiry:
                expiries.append(source_expiry)
        return min(expiries, default=None)

    def write(self, request):
        bank, doc = request.bankId, request.documentId
        key = self._key(bank, doc)
        raw = request.model_dump(mode="json")
        evidence = raw.pop("evidence")
        if evidence is not None:
            if request.kind != "experience" or len({ref["documentId"] for ref in evidence}) != len(evidence):
                raise ValueError("结构化依据只用于经验，且每份文档只能指定一个版本")
            raw["evidence"] = sorted(evidence, key=lambda ref: ref["documentId"])
        # 缺省依据沿用旧的请求序列化和幂等摘要。
        digest = hashlib.sha256(json.dumps(raw, sort_keys=True).encode("utf-8")).hexdigest()
        source = {"ref": request.source, "occurredAt": raw["occurredAt"]}
        if request.expiresAt and request.expiresAt <= request.occurredAt:
            raise ValueError("到期日期必须晚于来源日期")
        with self.lock:
            previous = self.records.get(key)
            version = request.expectedVersion + 1
            if previous and previous["state"] in {"forgetting", "forgotten"}:
                raise Conflict("已遗忘的记忆标识不可重放")
            if previous and previous["version"] == version and previous["digest"] == digest:
                if previous["state"] != "pending":
                    return {"status": previous["state"], "documentId": doc, "version": version}
            elif previous and (
                previous["state"] not in {"active", "pending_review"} or previous["version"] != request.expectedVersion
            ):
                raise Conflict("版本冲突或仍有未完成操作")
            elif not previous and request.expectedVersion != 0:
                raise Conflict("找不到待更正的记忆版本")
            if previous and previous.get("evidence") and evidence is None:
                raise Conflict("更正已追踪的经验须提供已核对的依据版本")
            reviews = self._dependent_reviews(bank, doc, previous)
            expiry = raw["expiresAt"]
            receipt = {"state": "pending", "version": version, "digest": digest, "expiresAt": expiry}
            if evidence is not None:
                receipt["expiresAt"] = self._evidence_expiry(bank, doc, evidence, reviews, expiry)
                receipt["evidence"] = raw["evidence"]
            # 先按同一回执暂停旧版本及其下游，再接触 Hindsight。
            self._save({**reviews, key: receipt})
            self.backend.ensure_bank(bank)
            self.backend.retain(
                bank, doc, request.text, source=source, version=version,
                expires_at=receipt["expiresAt"], kind=request.kind,
            )
            self._save({key: {**receipt, "state": "active"}})
            return {"status": "active", "documentId": doc, "version": version}

    def forget(self, target):
        key = self._key(target.bankId, target.documentId)
        with self.lock:
            previous = self.records.get(key)
            if not previous or previous["state"] != "forgotten":
                reviews = self._dependent_reviews(target.bankId, target.documentId, previous)
                self._save({**reviews, key: {"state": "forgetting"}})
            self.backend.forget(target.bankId, target.documentId)
            self._save({key: {"state": "forgotten"}})
            return {"status": "forgotten", "documentId": target.documentId}

    def forget_bank(self, target):
        with self.lock:
            keys = [key for key in self.records if key.startswith(f"{target.bankId}/")]
            pending = {key: {"state": "forgetting"} for key in keys if self.records[key]["state"] != "forgotten"}
            if pending:
                self._save(pending)
            for key in keys:
                self.forget(Target(bankId=target.bankId, documentId=key.split("/", 1)[1]))
            return {"status": "forgotten", "bankId": target.bankId, "documents": len(keys)}

    def review_status(self, target):
        with self.lock:
            return {"pendingReview": [
                {"documentId": key.split("/", 1)[1], "version": receipt["version"],
                 "evidence": [dict(ref) for ref in receipt["evidence"]]}
                for key, receipt in sorted(self.records.items())
                if key.startswith(f"{target.bankId}/") and receipt["state"] == "pending_review"
            ]}

    def _active(self, bank):
        today = datetime.now(timezone.utc).date().isoformat()
        return {
            key.split("/", 1)[1]: receipt["version"]
            for key, receipt in self.records.items()
            if key.startswith(f"{bank}/") and receipt["state"] == "active"
            and (receipt["expiresAt"] is None or receipt["expiresAt"] > today)
        }

    def recall(self, banks, query):
        results = []
        with self.lock:
            seen = set()
            for bank in banks:
                active = self._active(bank)
                if not active:
                    continue
                for item in self.backend.recall(bank, query, allowed_document_ids=list(active)):
                    doc = item.get("documentId")
                    identity = (bank, doc, item.get("text"))
                    if doc in active and item.get("version") == active[doc] and identity not in seen:
                        memory = {**item, "bankId": bank}
                        memory.pop("evidence", None)
                        evidence = self.records[self._key(bank, doc)].get("evidence")
                        if evidence:
                            memory["evidence"] = [dict(ref) for ref in evidence]
                        results.append(memory)
                        seen.add(identity)
        return {"memories": results[:5]}

    def reflect(self, request):
        with self.lock:
            active = self._active(request.bankId)
            if not active:
                return {"status": "insufficient_evidence"}
            candidate = self.backend.reflect(request.bankId, request.query, allowed_document_ids=list(active))
            sources = candidate.get("based_on", {}).get("memories", [])
            if not sources or any(
                item.get("documentId") not in active or active[item["documentId"]] != item.get("version")
                for item in sources
            ):
                return {"status": "insufficient_evidence"}
            return {"status": "pending", "candidate": candidate}


def _grants(entries, known_banks):
    grants = {}
    for entry in entries:
        token = os.environ.get(entry.tokenEnv, "").encode("utf-8")
        if not token.startswith(b"Bearer ") or len(token) < 31 or token in grants:
            raise ValueError(f"请设置独立的 Bearer 令牌：{entry.tokenEnv}")
        if not set(entry.banks) <= known_banks or len(set(entry.banks)) != len(entry.banks):
            raise ValueError(f"记忆库绑定缺失或重复：{entry.tokenEnv}")
        grants[token] = tuple(entry.banks)
    return grants


def make_app(service, bindings):
    readers = _grants(bindings.readers, set(bindings.banks))
    admins = _grants(bindings.administrators, set(bindings.banks))
    if readers.keys() & admins.keys():
        raise ValueError("管理凭据与只读凭据必须独立")

    def allowed(request, grants):
        token = request.headers.get("authorization", "").encode("utf-8")
        return next((banks for key, banks in grants.items() if hmac.compare_digest(token, key)), ())

    mcp = FastMCP("CoreMind Hindsight Memory", stateless_http=True, json_response=True)

    @mcp.tool(structured_output=False)
    def recall_memory(query: Query, ctx: Context) -> str:
        """查找当前任务可用的长期偏好和经验，附来源与版本。"""
        banks = allowed(ctx.request_context.request, readers)
        if not banks or not query.strip():
            raise ValueError("缺少授权或查询内容")
        return json.dumps(service.recall(banks, query.strip()), ensure_ascii=False)

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request):
        return JSONResponse({"status": "ready"})

    @mcp.custom_route("/admin/{action}", methods=["POST"])
    async def admin(request):
        operation = request.path_params["action"]
        banks = allowed(request, admins)
        operations = {"retain": (Write, service.write), "correct": (Write, service.write),
                      "forget": (Target, service.forget), "forget-bank": (BankTarget, service.forget_bank),
                      "reflect": (Reflection, service.reflect), "review-status": (BankTarget, service.review_status)}
        if operation not in operations:
            return JSONResponse({"error": "unknown_operation"}, status_code=404)
        model, handler = operations[operation]
        try:
            body = model.model_validate(await request.json())
            if body.bankId not in banks:
                return JSONResponse({"error": "scope_denied"}, status_code=403)
            if isinstance(body, Write) and ((operation == "retain") != (body.expectedVersion == 0)):
                return JSONResponse({"error": "invalid_version"}, status_code=400)
            return JSONResponse(await run_in_threadpool(handler, body))
        except Conflict as error:
            return JSONResponse({"error": str(error)}, status_code=409)
        except (ValidationError, ValueError):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        except Exception:
            return JSONResponse({"error": "hindsight_unavailable"}, status_code=502)

    app = mcp.streamable_http_app()

    async def authorized(scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope, receive)
            grants = admins if request.url.path.startswith("/admin/") else readers
            if not allowed(request, grants):
                return await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
        await app(scope, receive, send)

    return authorized


def main():
    from .backend import HindsightBackend

    parser = argparse.ArgumentParser(description="Serve host-authorized Hindsight memory over MCP.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--hindsight-url", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8769)
    args = parser.parse_args()
    bindings = Bindings.model_validate_json(args.config.read_text(encoding="utf-8"))
    backend = HindsightBackend(args.hindsight_url, os.getenv("COREMIND_HINDSIGHT_API_KEY"))
    try:
        uvicorn.run(make_app(MemoryService(backend, args.state), bindings), host="127.0.0.1",
                    port=args.port, access_log=False)
    finally:
        backend.close()


if __name__ == "__main__":
    main()
