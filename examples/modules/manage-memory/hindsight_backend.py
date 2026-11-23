"""通过固定版 Hindsight SDK 管理自托管记忆库。"""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from threading import RLock
from urllib.parse import urlsplit

from hindsight_client import Hindsight
from hindsight_client_api.exceptions import NotFoundException
from pydantic import BaseModel, ConfigDict, Field, ValidationError


def _document_tag(document_id: str) -> str:
    if not document_id or "*" in document_id:
        raise ValueError("记忆文档标识不能为空或包含通配符")
    return f"coremind-doc:{document_id}"


class _Reflection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    hasDirectEvidence: bool = Field(description="来源是否直接支持提问所需的全部关键事实，相近主题或缺少记录时为 false")
    rule: str = Field(description="可用于以后任务的经验规则，证据不足时留空")
    conditions: list[str] = Field(description="该规则适用的条件")
    counterexamples: list[str] = Field(description="依据支持的反例或失败情形")
    attribution: list[str] = Field(description="规则和反例分别来自哪些依据")
    needsConfirmation: list[str] = Field(description="需要宿主确认的问题")


def _fact(item: dict) -> dict | None:
    metadata = item.get("metadata") or {}
    try:
        raw_version = metadata["version"]
        version = int(raw_version)
        source = json.loads(metadata["source"])
    except (KeyError, TypeError, ValueError):
        return None
    if version < 1 or str(version) != raw_version or not isinstance(source, dict) or not source:
        return None
    return {
        **item,
        "documentId": item.get("document_id"),
        "source": source,
        "version": version,
        "expiresAt": metadata.get("expiresAt") or None,
        "kind": metadata.get("kind"),
    }


def _active(item: dict) -> bool:
    if item.get("state", "valid") != "valid":
        return False
    expiry = item["expiresAt"]
    if not expiry:
        return True
    try:
        deadline = date.fromisoformat(expiry)
    except (TypeError, ValueError):
        return False
    return deadline.isoformat() == expiry and deadline > datetime.now(timezone.utc).date()


class HindsightBackend:
    def __init__(self, base_url: str, api_key: str | None = None):
        endpoint = urlsplit(base_url)
        if (
            endpoint.scheme not in {"http", "https"}
            or not endpoint.hostname
            or endpoint.username is not None
            or endpoint.query
            or endpoint.fragment
        ):
            raise ValueError("请提供明确的 Hindsight 自托管 HTTP(S) 地址")
        self._client = Hindsight(base_url, api_key=api_key, max_attempts=1)
        # 官方异步 HTTP 会话绑定事件循环，多个工具线程共用一个循环。
        self._runner = asyncio.Runner()
        self._worker = ThreadPoolExecutor(max_workers=1)
        self._lock = RLock()
        self._closed = False

    def _run(self, coroutine):
        with self._lock:
            if self._closed:
                coroutine.close()
                raise RuntimeError("Hindsight 记忆连接已关闭")
            return self._worker.submit(self._runner.run, coroutine).result()

    def ensure_bank(self, bank_id: str) -> None:
        self._run(self._ensure_bank(bank_id))

    async def _ensure_bank(self, bank_id: str) -> None:
        # 仅文档列表明确区分不存在的库与空库。
        try:
            await self._client.documents.list_documents(bank_id, limit=1)
        except NotFoundException:
            await self._client.acreate_bank(
                bank_id, retain_extraction_mode="chunks", enable_observations=False
            )
        config = (await self._client.aget_bank_config(bank_id))["config"]
        if config.get("retain_extraction_mode") != "chunks" or config.get("enable_observations") is not False:
            raise RuntimeError("Hindsight 记忆库必须使用 chunks 并关闭观察自动提炼")

    def retain(
        self,
        bank_id: str,
        document_id: str,
        text: str,
        *,
        source: dict,
        version: int | str,
        expires_at: str | None = None,
        kind: str = "fact",
    ) -> None:
        response = self._run(
            self._client.aretain(
                bank_id,
                text,
                timestamp=f"{source['occurredAt']}T00:00:00Z",
                document_id=document_id,
                metadata={
                    "source": json.dumps(source, ensure_ascii=False, sort_keys=True),
                    "version": str(version),
                    "expiresAt": expires_at or "",
                    "kind": kind,
                },
                tags=[_document_tag(document_id)],
                update_mode="replace",
                resolve_entities=False,
            )
        )
        if not response.success or response.var_async or response.items_count != 1:
            raise RuntimeError("Hindsight 未确认完成记忆写入")

    def get_document(self, bank_id: str, document_id: str) -> dict | None:
        try:
            response = self._run(self._client.documents.get_document(bank_id, document_id))
        except NotFoundException:
            return None
        return response.model_dump(mode="json")

    def recall(
        self, bank_id: str, query: str, *, allowed_document_ids: list[str] | None = None
    ) -> list[dict]:
        if allowed_document_ids == []:
            return []
        tags = (
            [_document_tag(value) for value in allowed_document_ids]
            if allowed_document_ids is not None
            else None
        )
        response = self._run(
            self._client.arecall(
                bank_id,
                query,
                types=["world", "experience"],
                tags=tags,
                tags_match="any_strict",
            )
        )
        allowed = set(allowed_document_ids) if allowed_document_ids is not None else None
        matches = []
        for result in response.results:
            item = _fact(result.model_dump(mode="json"))
            if (
                item
                and item["documentId"]
                and (allowed is None or item["documentId"] in allowed)
                and _active(item)
            ):
                matches.append(item)
        return matches

    def reflect(
        self, bank_id: str, query: str, *, allowed_document_ids: list[str]
    ) -> dict:
        if not allowed_document_ids:
            return {}
        return self._run(self._reflect(bank_id, query, allowed_document_ids))

    async def _reflect(self, bank_id: str, query: str, allowed: list[str]) -> dict:
        question = (
            "只围绕以下待复盘问题生成候选。如果获准来源缺少问题要求的任何关键事实，"
            "将 hasDirectEvidence 设为 false、rule 留空。不要根据相近主题生成替代经验，"
            "也不要把未找到的内容写成不存在的事实。\n\n"
            f"待复盘问题：{query}"
        )
        response = await self._client.areflect(
            bank_id,
            question,
            tags=[_document_tag(value) for value in allowed],
            tags_match="any_strict",
            include_facts=True,
            fact_types=["world", "experience"],
            exclude_mental_models=True,
            response_schema=_Reflection.model_json_schema(),
        )
        basis = response.based_on
        if not basis or not basis.memories or basis.mental_models or basis.directives:
            return {}
        try:
            structured = _Reflection.model_validate(response.structured_output).model_dump()
        except ValidationError:
            return {}
        if response.structured_output_error or not structured.pop("hasDirectEvidence") or not structured["rule"]:
            return {}
        sources = []
        for citation in basis.memories:
            if not citation.id or (citation.document_id and citation.document_id not in allowed):
                return {}
            try:
                native = await self._client.memory.get_memory(bank_id, citation.id)
            except NotFoundException:
                return {}
            item = _fact(native)
            if (
                not item
                or item["documentId"] not in allowed
                or (citation.document_id and item["documentId"] != citation.document_id)
                or not _active(item)
                or item.get("text") != citation.text
            ):
                return {}
            sources.append(item)
        return {"structured_output": structured, "based_on": {"memories": sources}}

    def forget(self, bank_id: str, document_id: str) -> None:
        try:
            response = self._run(self._client.documents.delete_document(bank_id, document_id))
        except NotFoundException:
            return
        if not response.success:
            raise RuntimeError("Hindsight 未确认完成记忆文档删除")

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                self._run(self._client.aclose())
            finally:
                self._closed = True
                try:
                    self._worker.submit(self._runner.close).result()
                finally:
                    self._worker.shutdown(wait=True)
