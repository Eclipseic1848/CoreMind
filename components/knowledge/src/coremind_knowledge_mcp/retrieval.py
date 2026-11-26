"""在本机用 BGE-M3 和 Qdrant 检索有来源、权限和生效日期的知识块。"""

import hashlib
import json
import logging
import threading
from datetime import date
from pathlib import Path
from uuid import NAMESPACE_OID, uuid5

import numpy as np
import onnxruntime as ort
from qdrant_client import QdrantClient, models
from tokenizers import Tokenizer

MODEL_REPO = "gpahal/bge-m3-onnx-int8"
MODEL_REVISION = "2b34e84df040034d4b9eabb62383a87c18955822"
MODEL_FILES = {
    "model_quantized.onnx": "16de7ea1146ca427e14938ec3e9abfdcaff0e6ac76434cd693ac35d761250bcb",
    "tokenizer.json": "249df0778f236f6ece390de0de746838ef25b9d6954b68c2ee71249e0a9d8fd4",
}
# 编码或持久投影契约变更时递增，避免复用不相容的向量批次。
INDEX_ENCODING_REVISION = 2


def verify_model(directory):
    for name, expected in MODEL_FILES.items():
        with (Path(directory) / name).open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != expected:
                raise ValueError(f"模型文件摘要不符：{name}")


def ordinal(value):
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError("日期必须使用 YYYY-MM-DD")
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("日期必须使用 YYYY-MM-DD")
    return parsed.toordinal()


class KnowledgeIndex:
    def __init__(self, model_dir, *, index_dir=None):
        verify_model(model_dir)
        self.tokenizer = Tokenizer.from_file(str(Path(model_dir) / "tokenizer.json"))
        self.tokenizer.enable_padding(
            pad_id=self.tokenizer.token_to_id("<pad>"), pad_token="<pad>"
        )
        self.special = {
            self.tokenizer.token_to_id(t) for t in ("<s>", "</s>", "<pad>", "<unk>")
        }
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.model = ort.InferenceSession(
            str(Path(model_dir) / "model_quantized.onnx"),
            options,
            providers=["CPUExecutionProvider"],
        )
        self._persistent = index_dir is not None
        self._generation = None
        self._unconfirmed_generations = set()
        self.db = QdrantClient(path=str(index_dir)) if self._persistent else QdrantClient(":memory:")
        self.lock = threading.RLock()

    def close(self):
        with self.lock:
            self.db.close()

    def _encode(self, texts):
        encodings = self.tokenizer.encode_batch(texts)
        ids = np.asarray([item.ids for item in encodings], dtype=np.int64)
        if ids.shape[1] > 512:
            raise ValueError("单个知识块或问题超过 512 个 token，请先按来源位置拆分")
        mask = np.asarray([item.attention_mask for item in encodings], dtype=np.int64)
        dense, weights = self.model.run(
            ["dense_vecs", "sparse_vecs"], {"input_ids": ids, "attention_mask": mask}
        )
        for vector, token_weights, item in zip(dense, weights, encodings, strict=True):
            # BGE-M3 的词项权重取同一词项在各位置的最大正权重。
            sparse = {}
            for token, weight in zip(item.ids, token_weights.reshape(-1), strict=True):
                if token not in self.special and weight > 0:
                    sparse[token] = max(sparse.get(token, 0.0), float(weight))
            yield (
                vector.tolist(),
                models.SparseVector(indices=list(sparse), values=list(sparse.values())),
            )

    def replace(self, chunks, *, before_publish=None):
        payloads = []
        for chunk in chunks:
            for field in ("docId", "file", "text", "access"):
                if not isinstance(chunk.get(field), str) or not chunk[field].strip():
                    raise ValueError(f"缺少有效字段：{field}")
            version = chunk.get("version")
            if (
                isinstance(version, bool)
                or not isinstance(version, (str, int))
                or not str(version).strip()
            ):
                raise ValueError("缺少文档版本")
            line = chunk.get("line")
            locator = chunk.get("locator")
            if line is not None and (type(line) is not int or line < 1):
                raise ValueError("无效的来源行号")
            if line is None and not (isinstance(locator, str) and locator.strip()):
                raise ValueError("知识块缺少来源位置")
            start = ordinal(chunk["validFrom"])
            end = (
                ordinal(chunk["validUntil"])
                if chunk["validUntil"] is not None
                else date.max.toordinal() + 1
            )
            if start >= end:
                raise ValueError("无效的来源生效区间")
            payloads.append({**chunk, "_start": start, "_end": end})
        with self.lock:
            if self._persistent:
                self._replace_persistent(payloads, before_publish)
                return
            staged = QdrantClient(":memory:")
            self._create_collection(staged)
            try:
                for offset in range(0, len(payloads), 8):
                    batch = payloads[offset : offset + 8]
                    vectors = self._encode([p["text"] for p in batch])
                    staged.upsert(
                        "knowledge",
                        points=[
                            models.PointStruct(
                                id=offset + i,
                                payload=payload,
                                vector={"dense": dense, "sparse": sparse},
                            )
                            for i, (payload, (dense, sparse)) in enumerate(
                                zip(batch, vectors, strict=True)
                            )
                        ],
                    )
                # 新索引构建和目录落盘均成功后，读请求才可见新版本。
                if before_publish is not None:
                    before_publish()
            except Exception:
                staged.close()
                raise
            previous, self.db = self.db, staged
            previous.close()

    @staticmethod
    def _create_collection(db):
        db.create_collection(
            "knowledge",
            vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
            sparse_vectors_config={"sparse": models.SparseVectorParams()},
        )

    @staticmethod
    def _generation_filter(generation):
        return models.Filter(
            must=[models.FieldCondition(key="_generation", match=models.MatchValue(value=generation))]
        )

    def _generation_points(self, generation, *, with_vectors=False):
        offset = None
        while True:
            points, offset = self.db.scroll(
                "knowledge", scroll_filter=self._generation_filter(generation),
                limit=128, offset=offset, with_vectors=with_vectors,
            )
            yield from points
            if offset is None:
                return

    def _delete_generation(self, generation):
        self.db.delete("knowledge", points_selector=self._generation_filter(generation), wait=True)

    @staticmethod
    def _chunk_identity(payload):
        return tuple(payload.get(key) for key in (
            "docId", "version", "file", "line", "locator", "chunkId", "text",
        ))

    def _replace_persistent(self, payloads, before_publish):
        # 批次身份包含完整搜索投影，目录落盘是唯一提交点。
        projection = json.dumps(
            [INDEX_ENCODING_REVISION, MODEL_FILES, payloads],
            ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        )
        generation = hashlib.sha256(projection.encode("utf-8")).hexdigest()
        expected = {
            str(uuid5(NAMESPACE_OID, f"{generation}:{position}")): {**payload, "_generation": generation}
            for position, payload in enumerate(payloads)
        }
        if not self.db.collection_exists("knowledge"):
            self._create_collection(self.db)
        stored = {point.id: point.payload for point in self._generation_points(generation)}
        if stored != expected or generation in self._unconfirmed_generations:
            if generation == self._generation:
                raise RuntimeError("当前持久索引与已提交目录不一致")
            # Qdrant Local 先更新内存再写 SQLite，写入异常后必须重建该批次。
            self._unconfirmed_generations.add(generation)
            if stored:
                self._delete_generation(generation)
            by_identity = {}
            by_text = {}
            if self._generation is not None:
                for point in self._generation_points(self._generation, with_vectors=True):
                    by_identity[self._chunk_identity(point.payload)] = point.vector
                    by_text.setdefault(point.payload["text"], point.vector)
            incremental = any(payload["text"] in by_text for payload in payloads)
            entries = list(expected.items())
            for offset in range(0, len(entries), 8):
                batch = entries[offset : offset + 8]
                if incremental:
                    texts = list(dict.fromkeys(
                        payload["text"] for _, payload in batch if payload["text"] not in by_text
                    ))
                    if texts:
                        for text, (dense, sparse) in zip(texts, self._encode(texts), strict=True):
                            by_text[text] = {"dense": dense, "sparse": sparse}
                    vectors = (
                        by_identity.get(self._chunk_identity(payload), by_text[payload["text"]])
                        for _, payload in batch
                    )
                else:
                    # 量化 ONNX 对批次敏感，全量构建沿用内存索引的顺序和重复项。
                    vectors = (
                        {"dense": dense, "sparse": sparse}
                        for dense, sparse in self._encode([payload["text"] for _, payload in batch])
                    )
                self.db.upsert(
                    "knowledge",
                    points=[
                        models.PointStruct(id=point_id, payload=payload, vector=vector)
                        for (point_id, payload), vector in zip(batch, vectors, strict=True)
                    ],
                    wait=True,
                )
            if {point.id: point.payload for point in self._generation_points(generation)} != expected:
                raise RuntimeError("持久索引待提交批次不完整")
            self._unconfirmed_generations.remove(generation)
        if before_publish is not None:
            before_publish()
        previous, self._generation = self._generation, generation
        if previous is not None and previous != generation:
            try:
                self._delete_generation(previous)
            except Exception:
                logging.getLogger(__name__).warning("持久索引旧批次清理失败，新批次已提交")

    def search(self, question, *, scope, as_of, limit=5, mode="hybrid"):
        if not isinstance(question, str) or not question.strip():
            raise ValueError("问题不能为空")
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError("需要宿主提供读者权限")
        if (
            type(limit) is not int
            or not 1 <= limit <= 20
            or mode not in {"dense", "sparse", "hybrid"}
        ):
            raise ValueError("无效的检索模式或候选数")
        day = ordinal(as_of)
        visible = models.Filter(
            must=[
                models.FieldCondition(
                    key="access",
                    match=models.MatchAny(any=list(dict.fromkeys(["public", scope]))),
                ),
                models.FieldCondition(key="_start", range=models.Range(lte=day)),
                models.FieldCondition(key="_end", range=models.Range(gt=day)),
            ]
        )
        with self.lock:
            internal_fields = {"_start", "_end"}
            if self._persistent:
                if self._generation is None:
                    raise RuntimeError("持久索引尚未按知识目录初始化")
                visible.must.extend(self._generation_filter(self._generation).must)
                internal_fields.add("_generation")
            dense, sparse = next(self._encode([question]))
            if mode != "dense" and not sparse.indices:
                return []
            if mode != "sparse" and not any(dense):
                return []
            if mode == "hybrid":
                options = {
                    "query": models.FusionQuery(fusion=models.Fusion.RRF),
                    "prefetch": [
                        models.Prefetch(
                            query=vector,
                            using=key,
                            filter=visible,
                            limit=max(20, limit),
                        )
                        for key, vector in (("dense", dense), ("sparse", sparse))
                    ],
                }
            else:
                options = {"query": dense if mode == "dense" else sparse, "using": mode}
            points = self.db.query_points(
                "knowledge",
                **options,
                query_filter=visible,
                limit=limit,
                with_payload=True,
            ).points
            return [
                {k: v for k, v in point.payload.items() if k not in internal_fields}
                for point in points
            ]
