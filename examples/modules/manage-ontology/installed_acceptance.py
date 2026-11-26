"""从装有 wheel 的环境用真实 MCP 访问另一个进程，覆盖只读、业务回执和崩溃恢复。"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sysconfig
import time
from contextlib import closing, contextmanager
from datetime import timedelta
from importlib.metadata import distribution, distributions
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


@contextmanager
def service(console, folder, model, env, read_token, *, handler=None, journal=None):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    args = [console, "--model-dir", model, "--port", str(port)]
    if journal:
        args.extend(("--receipt-db", journal))
    if handler:
        args.extend(("--action-handler", handler))
    server = subprocess.Popen(args, cwd=folder, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    endpoint = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urlopen(Request(endpoint + "/health", headers={"Authorization": read_token}), timeout=1) as r:
                    assert json.load(r)["status"] == "ready"
                    break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError(f"服务启动失败，退出码 {server.returncode}")
                time.sleep(0.1)
        else:
            raise TimeoutError("本体服务未就绪")
        yield endpoint + "/mcp", server
    finally:
        if server.poll() is None:
            server.terminate()
        server.wait(timeout=15)


async def call(url, token, tool, **arguments):
    async with httpx.AsyncClient(headers={"Authorization": token}, trust_env=False, timeout=5) as http:
        async with streamable_http_client(url, http_client=http, terminate_on_close=False) as (rx, tx, _):
            async with ClientSession(rx, tx, read_timeout_seconds=timedelta(seconds=5)) as session:
                await session.initialize()
                response = await session.call_tool("ontology_" + tool, arguments)
                return json.loads(response.content[0].text)


async def expect_interruption(url, token, process, *, code, **arguments):
    try:
        await call(url, token, "perform_action", **arguments)
    except Exception:
        assert process.wait(timeout=10) == code
    else:
        raise AssertionError("发生合成故障后本体服务应已中断")


async def probe(folder, model_sources, handler, console):
    source = Path(shutil.copytree(model_sources / "document-review", folder / "model-v1"))
    revised = Path(shutil.copytree(source, folder / "model-v2"))
    actions = revised / "actions.json"
    config = json.loads(actions.read_text(encoding="utf-8"))
    config["modelVersion"] = "1.1.0"
    actions.write_text(json.dumps(config), encoding="utf-8")
    read, write = ["Bearer " + secrets.token_urlsafe(32) for _ in range(2)]
    env = {k: v for k, v in os.environ.items() if k.upper() not in {
        "PYTHONPATH", "PYTHONHOME", "COREMIND_ONTOLOGY_RECONCILE_AUTHORIZATION",
    }}
    business = folder / "business.sqlite3"
    env.update(COREMIND_ONTOLOGY_AUTHORIZATION=read, COREMIND_ONTOLOGY_ACTION_AUTHORIZATION=write,
               ONTOLOGY_BUSINESS_DB=str(business), PYTHONNOUSERSITE="1")
    guide, draft = "urn:doc:guide", "urn:doc:draft"
    with closing(sqlite3.connect(business)) as db, db:
        db.execute("CREATE TABLE objects(resource TEXT PRIMARY KEY, state TEXT)")
        db.execute("CREATE TABLE receipts(request_id TEXT PRIMARY KEY, receipt TEXT)")
        db.executemany("INSERT INTO objects VALUES(?, ?)", [(guide, "reviewed"), (draft, "draft")])
    with service(console, folder, source, env, read) as (url, _):
        first = await call(url, read, "describe", resource=guide)
        assert first["status"] == "available" and first["modelVersion"] == "1.0.0"
        good = {"externalId": "A3", "状态": "R", "克重": 1250, "owner": "urn:person:li"}
        for record, expected in ((good, "conforms"), ({k:v for k,v in good.items() if k!="owner"}, "violates"),
                                 ({**good, "externalId": "A2"}, "needs_confirmation")):
            assert (await call(url, read, "validate_record", source="catalog", record=record))["status"] == expected
        args = {"action": "publish", "resource": guide, "request_id": "publish-guide"}
        assert (await call(url, read, "perform_action", **args))["reason"] == "action_not_authorized"
    journal = folder / "action-receipts.sqlite3"
    adapter = folder / "receipt_handler.py"
    shutil.copy2(handler, adapter)
    crash = folder / "crash_after_commit.py"
    crash.write_text(
        'import json, os, runpy\nfrom pathlib import Path\n'
        'commit = runpy.run_path(str(Path(__file__).with_name("receipt_handler.py")))["execute"]\n'
        'def execute(command):\n'
        '    with Path(__file__).with_name("executor-attempts.jsonl").open("a", encoding="utf-8") as log:\n'
        '        log.write(json.dumps(command["requestId"]) + "\\n")\n'
        '    if command["requestId"] == "lost-failed": os._exit(97)\n'
        '    receipt = commit(command)\n'
        '    if command["requestId"] == "lost": os._exit(98)\n    return receipt\n', encoding="utf-8")
    with service(console, folder, source, env, read, handler=crash, journal=journal) as (url, proc):
        assert (await call(url, read, "perform_action", **args))["reason"] == "action_not_authorized"
        assert (await call(url, write, "perform_action", **{**args,"resource":draft}))["reason"] == "precondition_failed"
        assert (await call(url, write, "perform_action", **args))["status"] == "completed"
        await expect_interruption(url, write, proc, code=98,
                                  action="review", resource=draft, request_id="lost")
    for model in (revised, source):
        with service(console, folder, model, env, read, handler=adapter, journal=journal) as (url, _):
            info = await call(url, read, "describe", resource=guide)
            assert (info["bundleDigest"] == first["bundleDigest"]) == (model == source)
            assert info["modelVersion"] == ("1.0.0" if model == source else "1.1.0")
            assert any(p["value"]=="published" for p in info["properties"] if p["predicate"]=="urn:review:state")
            assert (await call(url, write, "perform_action", **args))["replayed"]
            lost = await call(url, write, "perform_action", action="review", resource=draft, request_id="lost")
            assert lost["status"] == "unknown" and lost["replayed"] and lost["modelVersion"]=="1.0.0"
            blocked = await call(url, write, "perform_action", action="review", resource=draft, request_id="new-id")
            assert blocked["reason"] == "prior_effect_unknown"
    with closing(sqlite3.connect(business)) as db:
        assert dict(db.execute("SELECT resource,state FROM objects")) == {guide:"published", draft:"reviewed"}
        assert sorted(x[0] for x in db.execute("SELECT request_id FROM receipts")) == ["lost","publish-guide"]
    return first["bundleDigest"]


async def probe_reconciliation(folder, console):
    read, write, reconcile = ["Bearer " + secrets.token_urlsafe(32) for _ in range(3)]
    business = folder / "business.sqlite3"
    env = {k: v for k, v in os.environ.items() if k.upper() not in {"PYTHONPATH", "PYTHONHOME"}}
    env.update(COREMIND_ONTOLOGY_AUTHORIZATION=read, COREMIND_ONTOLOGY_ACTION_AUTHORIZATION=write,
               COREMIND_ONTOLOGY_RECONCILE_AUTHORIZATION=reconcile, ONTOLOGY_BUSINESS_DB=str(business),
               PYTHONNOUSERSITE="1")
    journal = folder / "action-receipts.sqlite3"
    handler = folder / "crash_after_commit.py"
    model = folder / "model-v1"
    guide, draft = "urn:doc:guide", "urn:doc:draft"
    reviewed = {"action": "review", "resource": draft, "request_id": "lost"}
    failed = {"action": "publish", "resource": draft, "request_id": "lost-failed"}
    publish = {**failed, "request_id": "after-reconciliation"}

    def attempts():
        return [json.loads(row) for row in (folder / "executor-attempts.jsonl").read_text(encoding="utf-8").splitlines()]

    def business_snapshot():
        with closing(sqlite3.connect(business.as_uri() + "?mode=ro", uri=True)) as db:
            objects = dict(db.execute("SELECT resource,state FROM objects"))
            receipts = {request_id: json.loads(value) for request_id, value in
                        db.execute("SELECT request_id, receipt FROM receipts")}
        return objects, receipts

    async def post(url, body, *, token=reconcile, code=200):
        async with httpx.AsyncClient(headers={"Authorization": token}, trust_env=False, timeout=5) as client:
            response = await client.post(url.removesuffix("/mcp") + "/admin/reconcile-action", json=body)
        assert response.status_code == code, (response.status_code, response.text)
        return response.json()

    async def state(url):
        info = await call(url, read, "describe", resource=draft)
        return [p["value"] for p in info["properties"] if p["predicate"] == "urn:review:state"]

    initial_attempts = ["publish-guide", "lost"]
    assert attempts() == initial_attempts
    initial_state, initial_receipts = business_snapshot()
    assert initial_state == {guide: "published", draft: "reviewed"}
    confirmed = initial_receipts["lost"]
    assert confirmed == {"requestId": "lost", "resource": draft, "previousState": "draft",
                         "status": "completed", "state": "reviewed"}
    with service(console, folder, model, env, read, handler=handler, journal=journal) as (url, proc):
        prior = await call(url, write, "perform_action", **reviewed)
        assert prior["status"] == "unknown" and prior["replayed"]
        assert await state(url) == ["draft"]
        for token in (read, write):
            await post(url, confirmed, token=token, code=401)
        await post(url, {**confirmed, "requestId": "no-such-request"}, code=404)
        await post(url, {**confirmed, "unexpected": True}, code=400)
        for change in ({"resource": guide}, {"previousState": "reviewed"}, {"state": "published"}):
            await post(url, {**confirmed, **change}, code=409)
        assert (await call(url, write, "perform_action", **publish))["reason"] == "prior_effect_unknown"
        assert (await call(url, write, "perform_action", **reviewed))["status"] == "unknown"
        assert attempts() == initial_attempts and business_snapshot() == (initial_state, initial_receipts)

        completed = await post(url, confirmed)
        assert all(completed[key] == value for key, value in confirmed.items()) and not completed.get("replayed")
        assert await post(url, confirmed) == {**completed, "replayed": True}
        assert await call(url, write, "perform_action", **reviewed) == {**completed, "replayed": True}
        assert await state(url) == ["reviewed"]
        await post(url, {**confirmed, "status": "failed", "state": "draft"}, code=409)
        assert attempts() == initial_attempts and business_snapshot() == (initial_state, initial_receipts)
        await expect_interruption(url, write, proc, code=97, **failed)

    failed_attempts = [*initial_attempts, "lost-failed"]
    assert attempts() == failed_attempts and business_snapshot() == (initial_state, initial_receipts)
    unsuccessful = {"requestId": "lost-failed", "resource": draft, "previousState": initial_state[draft],
                    "status": "failed", "state": initial_state[draft]}
    with service(console, folder, model, env, read, handler=handler, journal=journal) as (url, _):
        assert await state(url) == ["reviewed"]
        assert await call(url, write, "perform_action", **reviewed) == {**completed, "replayed": True}
        assert (await call(url, write, "perform_action", **failed))["status"] == "unknown"
        assert (await call(url, write, "perform_action", **publish))["reason"] == "prior_effect_unknown"
        rejected = await post(url, unsuccessful)
        assert all(rejected[key] == value for key, value in unsuccessful.items()) and not rejected.get("replayed")
        assert await post(url, unsuccessful) == {**rejected, "replayed": True}
        assert await call(url, write, "perform_action", **failed) == {**rejected, "replayed": True}
        assert await state(url) == ["reviewed"]
        assert attempts() == failed_attempts and business_snapshot() == (initial_state, initial_receipts)
        next_action = await call(url, write, "perform_action", **publish)
        assert next_action["status"] == "completed" and next_action["state"] == "published"
        assert await state(url) == ["published"]

    final_attempts = [*failed_attempts, "after-reconciliation"]
    assert attempts() == final_attempts
    final_state, final_receipts = business_snapshot()
    assert final_state == {guide: "published", draft: "published"}
    assert sorted(final_receipts) == ["after-reconciliation", "lost", "publish-guide"]
    with service(console, folder, model, env, read, handler=handler, journal=journal) as (url, _):
        assert await state(url) == ["published"]
        assert await call(url, write, "perform_action", **failed) == {**rejected, "replayed": True}
        assert await post(url, unsuccessful) == {**rejected, "replayed": True}
        assert await post(url, confirmed) == {**completed, "replayed": True}
        assert await call(url, write, "perform_action", **publish) == {**next_action, "replayed": True}
    assert attempts() == final_attempts and business_snapshot() == (final_state, final_receipts)
    return {"reconciledStatuses": {"lost": "completed", "lost-failed": "failed"},
            "verifiedAuthorizationAndConflicts": True, "reconcileExecutorCalls": 0,
            "executorAttempts": final_attempts, "businessReceipts": len(final_receipts),
            "laterAction": next_action["status"], "finalStateAfterRestart": final_state[draft]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, help="空的外部业务目录；提供后保留模型和回执供卸载核对")
    parser.add_argument("--reconcile", action="store_true", help="验收当前候选 wheel 的回执对账和后续动作")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    console = Path(sysconfig.get_path("scripts")) / ("coremind-ontology-mcp.exe" if os.name=="nt" else "coremind-ontology-mcp")
    dist = distribution("coremind-ontology-mcp")
    assert dist.version == "0.1.0" and subprocess.check_output([console,"--version"],text=True,encoding="utf-8").strip()==dist.version
    isolated_packages = {item.metadata["Name"].lower() for item in distributions()}
    assert not ({"coremind-ai", "hindsight-client", "qdrant-client"} & isolated_packages)
    with TemporaryDirectory(prefix="coremind-ontology-") as tmp:
        folder = args.project.resolve() if args.project else Path(tmp)
        folder.mkdir(parents=True,exist_ok=True)
        if any(folder.iterdir()):
            raise SystemExit("验收需要空的业务目录")
        digest = asyncio.run(probe(folder,here/"models",here/"receipt_handler.py",console))
        report = {"component":dist.version,"modelBundle":digest,"readMappingChecks":3,
                  "businessReceipts":2,"unknownReplayBlocked":True,"modelRollback":"1.0.0"}
        if args.reconcile:
            report.update(asyncio.run(probe_reconciliation(folder, console)))
        print(json.dumps(report))
