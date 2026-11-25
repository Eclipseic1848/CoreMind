"""示例业务系统：更新调用方预置的 SQLite 对象，原子保存实际事务回执。"""

import json
import os
import sqlite3
from contextlib import closing


def execute(command):
    with closing(sqlite3.connect(os.environ["ONTOLOGY_BUSINESS_DB"])) as db, db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT receipt FROM receipts WHERE request_id=?", (command["requestId"],)).fetchone()
        if prior:
            return json.loads(prior[0])
        resource = command["resource"]
        before, after = command["previousState"], command["expectedState"]
        changed = db.execute("UPDATE objects SET state=? WHERE resource=? AND state=?", (after, resource, before))
        if changed.rowcount != 1:
            return None
        state, = db.execute("SELECT state FROM objects WHERE resource=?", (resource,)).fetchone()
        receipt = {"requestId": command["requestId"], "resource": resource, "previousState": before,
                   "status": "completed", "state": state}
        db.execute("INSERT INTO receipts VALUES (?, ?)", (command["requestId"], json.dumps(receipt)))
        return receipt
