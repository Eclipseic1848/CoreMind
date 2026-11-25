"""在本机用 BGE-M3 和 Qdrant 检索有来源、权限和生效日期的知识块。"""

import hashlib
import threading
from datetime import date
from pathlib import Path

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
    def __init__(self, model_dir):
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
        self.db = QdrantClient(":memory:")
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
            staged = QdrantClient(":memory:")
            staged.create_collection(
                "knowledge",
                vectors_config={
                    "dense": models.VectorParams(
                        size=1024, distance=models.Distance.COSINE
                    )
                },
                sparse_vectors_config={"sparse": models.SparseVectorParams()},
            )
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
                {k: v for k, v in point.payload.items() if k not in {"_start", "_end"}}
                for point in points
            ]
