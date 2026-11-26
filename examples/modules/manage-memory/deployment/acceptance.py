"""在全新回环实例验收 Hindsight 部署、旧备份恢复和网关切换。"""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from check_component import recall


MODEL_FILES = {
    "model_quantized.onnx": "16de7ea1146ca427e14938ec3e9abfdcaff0e6ac76434cd693ac35d761250bcb",
    "tokenizer.json": "249df0778f236f6ece390de0de746838ef25b9d6954b68c2ee71249e0a9d8fd4",
}
READ = "COREMIND_MEMORY_AUTHORIZATION"
OTHER = "COREMIND_MEMORY_OTHER_AUTHORIZATION"
ADMIN = "COREMIND_MEMORY_ADMIN_AUTHORIZATION"
BANK = "subject-a"
FORGOTTEN = "forgotten-after-backup"
CONTROL = "kept-after-restore"
TEXT = "校验条目：资料摘要使用琥珀色表格。"
CONTROL_TEXT = "校验条目：专题档案仅提供只读副本。"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def port_on_loopback():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(client, proc, url, token=None):
    deadline = time.monotonic() + 120
    headers = {"Authorization": token} if token else {}
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("服务提前退出，请检查演练日志")
        try:
            if client.get(url, headers=headers, timeout=2).status_code == 200:
                return
        except httpx.TransportError:
            pass
        time.sleep(0.5)
    raise TimeoutError("服务未就绪，请检查演练日志")


@contextmanager
def serve(command, env, cwd, log):
    with log.open("wb") as stream:
        proc = subprocess.Popen(
            command, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
            stdout=stream, stderr=subprocess.STDOUT,
        )
        try:
            yield proc
        finally:
            if proc.poll() is None:
                if os.name == "nt":
                    # Windows 虚拟环境重定向器可能另启 Python 子进程。
                    subprocess.run(
                        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                        capture_output=True, check=False, timeout=15,
                    )
                else:
                    proc.terminate()
                proc.wait(timeout=30)


def exercise(args, work, http):
    for name, expected in MODEL_FILES.items():
        if digest(args.model_dir / name) != expected:
            raise ValueError(f"验收模型摘要不符：{name}")
    for package, expected in [("hindsight-api-slim", "1.2.3"), ("coremind-memory-mcp", "0.1.0")]:
        if importlib.metadata.version(package) != expected:
            raise ValueError(f"验收需要 {package} {expected}")
    if args.previous_source is not None and not (args.previous_source / "memory_server.py").is_file():
        raise ValueError("请提供已验签的 CoreMind 2.0.0 源码示例目录")

    pgdata = work / "pgdata"
    tokenizer = work / "tokenizer"
    tokenizer.mkdir()
    shutil.copyfile(args.model_dir / "tokenizer.json", tokenizer / "tokenizer.json")
    (tokenizer / "config.json").write_text('{"model_type":"xlm-roberta"}\n', encoding="utf-8")
    shutil.copyfile(HERE / "bindings.example.json", work / "bindings.json")

    db_port = port_on_loopback()
    password = secrets.token_hex(32)
    grants = {name: "Bearer " + secrets.token_hex(24) for name in (READ, OTHER, ADMIN)}
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "HOME", "COMSPEC", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
    }}
    env.update(
        NO_PROXY="127.0.0.1,localhost", PYTHONUTF8="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1", OTEL_SDK_DISABLED="true", DO_NOT_TRACK="1",
    )
    postgres_env = dict(env, PGHOST="127.0.0.1", PGPORT=str(db_port), PGUSER="hindsight", PGPASSWORD=password,
                        PGCLIENTENCODING="UTF8")

    def pg(tool, *params):
        exe = args.pg_bin / (tool + (".exe" if os.name == "nt" else ""))
        command = [exe, *map(str, params)]
        log_path = work / "postgres-tools.log"
        if tool == "pg_ctl":
            # Windows 后台实例会继承管道句柄，用文件接收 pg_ctl 的输出。
            with log_path.open("ab") as log:
                subprocess.run(command, env=postgres_env, cwd=work, stdin=subprocess.DEVNULL,
                               stdout=log, stderr=subprocess.STDOUT, timeout=90, check=True)
            return None
        result = subprocess.run(
            command, env=postgres_env, cwd=work, capture_output=True, timeout=90,
        )
        with log_path.open("ab") as log:
            log.write(result.stdout + result.stderr)
        result.check_returncode()
        return result.stdout.decode("utf-8").strip()

    def sql(database, query):
        return pg("psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", query)

    @contextmanager
    def native(database):
        port = port_on_loopback()
        url = f"http://127.0.0.1:{port}"
        native_env = dict(
            env, HINDSIGHT_API_DATABASE_URL=f"postgresql://hindsight:{password}@127.0.0.1:{db_port}/{database}",
            HINDSIGHT_API_LLM_PROVIDER="none", HINDSIGHT_API_EMBEDDINGS_PROVIDER="onnx",
            HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH=str(args.model_dir / "model_quantized.onnx"),
            HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH=str(tokenizer),
            HINDSIGHT_API_EMBEDDINGS_ONNX_OUTPUT_NAME="dense_vecs", HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS="1024",
            HINDSIGHT_API_RERANKER_PROVIDER="rrf", HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION="false",
            HINDSIGHT_API_LLM_TRACE_ENABLED="false", HINDSIGHT_API_RETAIN_EXTRACTION_MODE="chunks",
            HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT="true",
        )
        begin = time.monotonic()
        cmd = [sys.executable, "-I", "-B", "-X", "utf8", "-m", "hindsight_api.main", "--host", "127.0.0.1", "--port", str(port)]
        with serve(cmd, native_env, work, work / f"{database}.log") as proc:
            wait_ready(http, proc, url + "/health/ready")
            yield url, round(time.monotonic() - begin, 3)

    @contextmanager
    def gateway(native_url, stage, previous=False):
        port = port_on_loopback()
        url = f"http://127.0.0.1:{port}"
        entry = [args.previous_source / "memory_server.py"] if previous else ["-I", "-m", "coremind_memory_mcp.server"]
        cmd = [sys.executable, "-B", "-X", "utf8", *entry, "--hindsight-url", native_url,
               "--config", work / "bindings.json", "--state", work / "receipts.json", "--port", str(port)]
        with serve(cmd, dict(env, **grants), work, work / f"{stage}.log") as proc:
            wait_ready(http, proc, url + "/health", grants[READ])
            assert http.get(url + "/health").status_code == 401
            yield url
        try:
            http.get(url + "/health", timeout=1)
        except httpx.TransportError:
            pass
        else:
            raise RuntimeError("演练网关端口停止后仍响应")

    def post(url, action, body, expected=200):
        result = http.post(f"{url}/admin/{action}", headers={"Authorization": grants[ADMIN]}, json=body)
        assert result.status_code == expected, (action, result.status_code)
        return result.json()

    def verify_hit(url, target, text, exists=True):
        hits = asyncio.run(recall(url, grants[READ], text))
        matches = [hit for hit in hits if hit["documentId"] == target]
        if exists:
            assert len(matches) == 1 and matches[0]["text"] == text
            assert matches[0]["bankId"] == BANK and matches[0]["version"] == 1
            assert matches[0]["source"]["ref"] == "fixture:host-confirmed"
        else:
            assert not matches

    def rows(database, table, column):
        return int(sql(database, f"SELECT count(*) FROM {table} WHERE bank_id = '{BANK}' AND {column} = '{FORGOTTEN}'"))

    def body(target, text):
        return {"bankId": BANK, "documentId": target, "expectedVersion": 0, "text": text,
                "source": "fixture:host-confirmed", "occurredAt": "2026-01-01", "kind": "fact"}

    pwfile = work / "initdb.secret"
    try:
        pwfile.write_text(password + "\n", encoding="utf-8")
        pg("initdb", "-D", pgdata, "-U", "hindsight", "-A", "scram-sha-256", f"--pwfile={pwfile}",
           "--encoding=UTF8", "--no-locale")
    finally:
        pwfile.unlink(missing_ok=True)
    try:
        pg("pg_ctl", "-D", pgdata, "-l", work / "postgres.log", "-o",
           f"-h 127.0.0.1 -p {db_port}", "-w", "-t", "60", "start")
        pg("pg_isready", "-d", "postgres")
        if Path(sql("postgres", "SHOW data_directory")).resolve() != pgdata.resolve():
            raise RuntimeError("PostgreSQL 目录与演练实例不匹配")
        version = sql("postgres", "SHOW server_version")
        if version.split()[0] != "18.1":
            raise ValueError("验收需要 PostgreSQL 18.1")
        sql("postgres", "CREATE DATABASE cm_source")
        sql("postgres", "CREATE DATABASE cm_restored TEMPLATE template0")
        vector = sql("cm_source", "CREATE EXTENSION vector; SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        if vector.splitlines()[-1] != "0.8.5":
            raise ValueError("验收需要 pgvector 0.8.5")
        target = {"bankId": BANK, "documentId": FORGOTTEN}
        dump = work / "postgres-before-forget.dump"
        with native("cm_source") as (url, native_seconds):
            with gateway(url, "initial-gateway") as entry:
                for document_id, text in [(FORGOTTEN, TEXT), (CONTROL, CONTROL_TEXT)]:
                    assert post(entry, "retain", body(document_id, text))["version"] == 1
                verify_hit(entry, FORGOTTEN, TEXT)
                assert asyncio.run(recall(entry, grants[OTHER], TEXT)) == []
            # 停止网关写入后，备份同一时点的数据库和回执。
            shutil.copyfile(work / "receipts.json", work / "receipts-at-backup.json")
            backup_start = time.monotonic()
            pg("pg_dump", "--format=custom", "--no-owner", "--no-privileges", "-f", dump, "-d", "cm_source")
            backup_seconds = round(time.monotonic() - backup_start, 3)
            with gateway(url, "restarted-gateway") as entry:
                verify_hit(entry, FORGOTTEN, TEXT)
                assert post(entry, "forget", target)["status"] == "forgotten"
                verify_hit(entry, FORGOTTEN, TEXT, exists=False)
            assert rows("cm_source", "documents", "id") == rows("cm_source", "memory_units", "document_id") == 0

        restore_start = time.monotonic()
        pg("pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
           "-d", "cm_restored", dump)
        restore_seconds = round(time.monotonic() - restore_start, 3)
        assert rows("cm_restored", "documents", "id") == 1 and rows("cm_restored", "memory_units", "document_id") > 0
        with native("cm_restored") as (url, restored_native_seconds):
            with gateway(url, "restored-gateway") as entry:
                # 保留最新回执，避免恢复的旧行在重放遗忘前被召回。
                verify_hit(entry, FORGOTTEN, TEXT, exists=False)
                verify_hit(entry, CONTROL, CONTROL_TEXT)
                post(entry, "retain", body(FORGOTTEN, TEXT), expected=409)
                for _ in range(2):
                    assert post(entry, "forget", target)["status"] == "forgotten"
                assert rows("cm_restored", "documents", "id") == rows("cm_restored", "memory_units", "document_id") == 0
                verify_hit(entry, CONTROL, CONTROL_TEXT)
            if args.previous_source is not None:
                with gateway(url, "rollback-2.0", previous=True) as entry:
                    verify_hit(entry, FORGOTTEN, TEXT, exists=False)
                    verify_hit(entry, CONTROL, CONTROL_TEXT)
                with gateway(url, "upgrade-0.1.0") as entry:
                    verify_hit(entry, FORGOTTEN, TEXT, exists=False)
                    verify_hit(entry, CONTROL, CONTROL_TEXT)
        result = {
            "postgres": version, "pgvector": "0.8.5", "hindsight": "1.2.3", "gateway": "0.1.0",
            "platform": sys.platform, "python": sys.version.split()[0], "workDir": str(work),
            "backupSha256": digest(dump), "backupBytes": dump.stat().st_size,
            "receiptsAtBackupSha256": digest(work / "receipts-at-backup.json"),
            "latestReceiptsSha256": digest(work / "receipts.json"),
            "durationSeconds": {"hindsightReady": native_seconds, "restoreHindsightReady": restored_native_seconds,
                                "pgDump": backup_seconds, "pgRestore": restore_seconds},
            "verified": ["ready-and-authenticated-recall", "isolated-reader", "restart-preserves-recall",
                         "restored-old-rows", "latest-receipts-block-old-data", "replay-forgetting-twice",
                         "native-deletion", "control-still-readable", "gateway-stops"],
        }
        if args.previous_source is not None:
            result["verified"].append("rollback-2.0.0-and-upgrade-0.1.0")
    finally:
        if (pgdata / "postmaster.pid").exists():
            pg("pg_ctl", "-D", pgdata, "-m", "fast", "-w", "stop")
    if (pgdata / "postmaster.pid").exists():
        raise RuntimeError("演练 PostgreSQL 未停止")
    result["verified"].append("postgres-stops")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--previous-source", type=Path)
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args()
    for field in ("pg_bin", "model_dir", "previous_source"):
        value = getattr(args, field)
        if value is not None:
            setattr(args, field, value.resolve(strict=True))
    if args.work_dir is None:
        work = Path(tempfile.mkdtemp(prefix="coremind-memory-deployment-"))
    else:
        work = args.work_dir.resolve()
        work.mkdir(parents=True)
    print(f"演练日志：{work}", file=sys.stderr, flush=True)
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    with httpx.Client(timeout=30, trust_env=False) as http:
        result = exercise(args, work, http)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
