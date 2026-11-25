"""在调用业务处理器前持久保留请求；服务进程独占一个业务项目的回执库。"""

import json
import sqlite3
from pathlib import Path


class ActionJournal:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, timeout=1, check_same_thread=False)
        try:
            self.db.execute("PRAGMA locking_mode=EXCLUSIVE")
            self.db.execute("PRAGMA synchronous=FULL")
            with self.db:
                self.db.execute("BEGIN EXCLUSIVE")
                version = self.db.execute("PRAGMA user_version").fetchone()[0]
                if version == 0 and not self.db.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone():
                    self.db.execute("CREATE TABLE action_receipts (request_id TEXT PRIMARY KEY, result TEXT NOT NULL)")
                    self.db.execute("PRAGMA user_version=1")
                elif version != 1:
                    raise ValueError("回执库不是支持的 1 版格式")
                self.db.execute("SELECT request_id, result FROM action_receipts LIMIT 0")
        except BaseException:
            self.db.close()
            raise

    def records(self):
        for request_id, result in self.db.execute("SELECT request_id, result FROM action_receipts ORDER BY rowid"):
            parsed = json.loads(result)
            if request_id != parsed["requestId"] or parsed["status"] not in {"unknown", "completed", "failed"}:
                raise ValueError("回执库记录损坏")
            yield parsed

    def reserve(self, result):
        with self.db:
            self.db.execute("INSERT INTO action_receipts VALUES (?, ?)",
                            (result["requestId"], json.dumps(result, ensure_ascii=False)))

    def finish(self, result):
        with self.db:
            self.db.execute("UPDATE action_receipts SET result=? WHERE request_id=?",
                            (json.dumps(result, ensure_ascii=False), result["requestId"]))

    def close(self):
        self.db.close()
