"""按稳定文档 ID 与版本管理知识块，支持幂等导入、撤回和旧引文解析。"""

import hashlib
import json
import os
from pathlib import Path


class KnowledgeVersionConflict(ValueError):
    """同一文档版本出现了不同内容。"""


def fingerprint(record):
    content = {key: value for key, value in record.items() if key != "withdrawn"}
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def table_context(record, chunk):
    header = record.get("tableHeaders", {}).get(str(chunk.get("line")))
    return {"tableHeader": [header]} if header is not None else {}


class KnowledgeCatalog:
    def __init__(self, index, state_path=None):
        self.index = index
        self.state_path = Path(state_path) if state_path is not None else None
        self.documents = {}
        if self.state_path is not None and self.state_path.exists():
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
            if state.get("schemaVersion") != 1:
                raise ValueError("知识状态版本不受支持")
            for record in state["documents"]:
                self.documents[(record["docId"], record["version"])] = record
        self.index.replace(self._active_chunks(self.documents))

    def import_document(self, record):
        result = self.import_documents([record])
        return "imported" if result["imported"] else "unchanged"

    def import_documents(self, records, *, withdrawals=()):
        documents = dict(self.documents)
        imported = 0
        unchanged = 0
        for record in records:
            self._validate(record)
            key = (record["docId"], record["version"])
            existing = documents.get(key)
            if existing is not None:
                if "tableHeaders" not in existing and "tableHeaders" in record:
                    # 旧状态未保存表格结构。先补派生字段，再对照同版本的原文、位置和范围。
                    existing = {**existing, "tableHeaders": record["tableHeaders"]}
                if fingerprint(existing) == fingerprint(record):
                    documents[key] = existing
                    unchanged += 1
                    continue
                raise KnowledgeVersionConflict(
                    f"文档 {record['docId']} 版本 {record['version']} 内容已变化；请提升版本号"
                )
            documents[key] = record
            imported += 1
        for key in withdrawals:
            if key not in documents:
                raise ValueError("未知的文档版本")
            documents[key] = {**documents[key], "withdrawn": True}
        if documents != self.documents:
            self._commit(documents)
        return {"imported": imported, "unchanged": unchanged}

    def withdraw(self, doc_id, version):
        self.import_documents([], withdrawals=[(doc_id, version)])
        return "withdrawn"

    def search(self, query, *, scope, as_of, limit=5, mode="sparse"):
        return self.index.search(
            query, scope=scope, as_of=as_of, limit=limit, mode=mode
        )

    def resolve(self, doc_id, version, file, line=None, locator=None, *, scope, as_of):
        record = self.documents.get((doc_id, version))
        if (
            record is None
            or record["access"] not in {"public", scope}
            or as_of < record["validFrom"]
            or (record["validUntil"] is not None and as_of >= record["validUntil"])
        ):
            return {"status": "unknown", "docId": doc_id, "version": version}
        if record.get("withdrawn"):
            return {"status": "withdrawn", "docId": doc_id, "version": version}
        for chunk in record["chunks"]:
            if chunk.get("file", record["file"]) != file:
                continue
            if line is not None and chunk.get("line") != line:
                continue
            if locator is not None and chunk.get("locator") != locator:
                continue
            return {
                "status": "available",
                "docId": doc_id,
                "version": version,
                "file": file,
                "line": chunk.get("line"),
                "locator": chunk.get("locator"),
                "text": chunk["text"],
                **table_context(record, chunk),
            }
        return {
            "status": "missing",
            "docId": doc_id,
            "version": version,
            "file": file,
        }

    @staticmethod
    def _active_chunks(documents):
        chunks = []
        for record in documents.values():
            if record.get("withdrawn"):
                continue
            for chunk in record["chunks"]:
                chunks.append(
                    {
                        **chunk,
                        **table_context(record, chunk),
                        "docId": record["docId"],
                        "version": record["version"],
                        "file": record["file"],
                        "access": record["access"],
                        "validFrom": record["validFrom"],
                        "validUntil": record["validUntil"],
                    }
                )
        return chunks

    def _commit(self, documents):
        chunks = self._active_chunks(documents)
        if self.state_path is None:
            self.index.replace(chunks)
        else:
            self.index.replace(chunks, before_publish=lambda: self._save(documents))
        self.documents = documents

    def _save(self, documents):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        state = {
            "schemaVersion": 1,
            "documents": list(documents.values()),
        }
        temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        try:
            temporary.write_text(
                json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temporary, self.state_path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _validate(record):
        for field in ("docId", "file", "access", "validFrom"):
            value = record.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"缺少有效字段：{field}")
        version = record.get("version")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ValueError("文档版本必须是正整数")
        chunks = record.get("chunks")
        if not isinstance(chunks, list) or not chunks:
            raise ValueError("文档至少需要一个知识块")
        for chunk in chunks:
            if not isinstance(chunk.get("text"), str) or not chunk["text"].strip():
                raise ValueError("知识块正文不能为空")
            if chunk.get("line") is None and not chunk.get("locator"):
                raise ValueError("知识块缺少来源位置")
