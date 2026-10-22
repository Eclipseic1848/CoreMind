from pathlib import Path
import datetime, hashlib, json, os, shutil, subprocess, sys, time

BASE = "04f898fbc8b65ef40458e1be60aba86133ab4298"
TOOLCHAIN_SOURCE = "6332ac55e58a1e810596a0e849fd0978f29bf88a"
root = Path(__file__).resolve().parents[1]
evidence = root / ".scratch/issue-354/evidence"
evidence.mkdir(parents=True)
calls, snapshots = evidence / "calls.jsonl", evidence / "snapshots.jsonl"
preload, supervisor = root / "scripts/probe-python-command.mjs", root / "scripts/supervise-python.ps1"
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
write = lambda p, value: p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
git = lambda *args: subprocess.check_output(["git", *args], cwd=root).decode("utf-8").strip()
artifacts = {
    "packages/coremind/dist/index.js": "dbc97642584a6bef3a723e58bfbfc8e897489e319c703685bdc856ee7738f45c",
    "packages/coremind/dist/index.js.map": "0936cd9fa1a9b5719c801e3fcbfecc49da8d493f71c41cb0d02c0a078e71d8b7",
    "packages/coremind-runtime/dist/index.js": "3b2360777ce3e75b6dd18b94dce44bd092e37ee62b81f118cc4c91f2de372be6",
    "packages/coremind-runtime/dist/index.js.map": "4aefaf9c9685f0e2eb163f2cba4aa4f07a4196b16bdaf32cd53bfa2b52e0b715",
    "packages/coremind-runtime/dist/runtime.js": "60d09296b6cb0c621bfa33629adb8dfd62c5dae7dddc8682a6f0eec1c90dca1a",
    "packages/coremind-runtime/dist/runtime.js.map": "047a9f32fe821e630cb91b71a933ad9a652bb3c7f6b47d14ab0a1cd5a164e52b",
    "packages/coremind-runtime/dist/coding/engineering-kernel.js": "a2a09973d71bb8c77bad752b03bd75a6102ebf298a07dc378364b5e1e87ff2da",
    "packages/coremind-runtime/dist/coding/engineering-kernel.js.map": "dc49b86874aa593d2be239cad56af5fe6216278536f79d7adeda6ffe359552be",
}
sources = ["examples/coding-evals/engineering-kernel.test.ts", "examples/coding-evals/_shared/command.ts", "examples/coding-evals/vitest.config.ts"]
metadata = {"atUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "base": BASE,
    "run": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    "maximumProjectRuns": 1, "expectedProjectCases": 8, "firstAnomalyStops": True, "originalCommandTimeoutMs": 30000,
    "primaryPythonCaseTimeoutMs": 150000, "outerDiagnosticWatchdogSeconds": 180,
    "outerWatchdogIsNotProductFailure": True, "qualifiesAsEngineering": False,
    "originalRootCauseConfirmed": False, "passingDoesNotEstablishRepair": True,
    "securityPatchIssue": 355, "toolchainSource": TOOLCHAIN_SOURCE,
    "toolchainChangeIsNotOriginalTimeoutRepair": True}
try:
    assert os.name == "nt", "Windows diagnostic only"
    python = Path(sys.executable).resolve()
    node_path, pwsh = shutil.which("node"), shutil.which("pwsh")
    assert node_path and pwsh, "node and pwsh must be available"
    node = Path(node_path).resolve()
    metadata.update(head=git("rev-parse", "HEAD"), tree=git("rev-parse", "HEAD^{tree}"),
        python=str(python), pythonVersion=sys.version, pythonSha256=sha(python),
        node=str(node), nodeVersion=subprocess.check_output([str(node), "--version"], text=True, encoding="utf-8").strip(), nodeSha256=sha(node))
    assert sys.version_info[:3] == (3, 11, 9) and metadata["nodeVersion"] == "v22.23.3", "executable version mismatch"
    assert metadata["pythonSha256"] == "5f7b89a612c9b8af1d6456cdfcd1dbe5ca630849e79aebced9bee9a6694952ec", "Python image mismatch"
    assert metadata["nodeSha256"] == "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e", "Node image mismatch"
    assert not os.environ.get("GITHUB_SHA") or os.environ["GITHUB_SHA"] == metadata["head"], "checkout head mismatch"
    subprocess.run(["git", "merge-base", "--is-ancestor", BASE, "HEAD"], cwd=root, check=True)
    changed = set(git("diff", "--name-only", BASE).splitlines()) | set(git("ls-files", "--others", "--exclude-standard").splitlines())
    allowed = {".github/workflows/ci.yml", "scripts/diagnose-original-python-command.py", "scripts/probe-python-command.mjs", "scripts/supervise-python.ps1", "package.json", "package-lock.json"}
    metadata["changedPaths"] = sorted(changed)
    assert changed == allowed, "diagnostic diff must contain only four temporary files and two approved toolchain files"
    metadata["testToolchainFiles"] = {p: sha(root / p) for p in ("package.json", "package-lock.json")}
    for package in metadata["testToolchainFiles"]:
        assert subprocess.check_output(["git", "show", TOOLCHAIN_SOURCE + ":" + package], cwd=root) == (root / package).read_bytes(), package + " differs from approved security patch bytes"
    metadata["sources"] = {p: sha(root / p) for p in sources}
    for source in sources:
        assert subprocess.check_output(["git", "show", BASE + ":" + source], cwd=root) == (root / source).read_bytes(), source + " differs from original bytes"
    metadata["artifacts"] = {p: sha(root / p) for p in artifacts}
    assert metadata["artifacts"] == artifacts, "controlled build artifact mismatch"
    metadata["helpers"] = {p.name: sha(p) for p in (preload, supervisor, Path(__file__))}
    write(evidence / "intent.json", metadata)
except Exception as error:
    write(evidence / "preparation-failed.json", {**metadata, "preparationFailed": True, "errorType": type(error).__name__, "error": str(error)})
    raise

env = os.environ.copy()
env["PATH"] = str(python.parent) + os.pathsep + str(node.parent) + os.pathsep + env["PATH"]
env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --import=" + preload.as_uri()).strip()
env["COREMIND_COMMAND_PROBE_LOG"] = str(calls)
results = []
observer = None
observer_ready = False
try:
    with (evidence / "observer.stdout.log").open("wb") as out, (evidence / "observer.stderr.log").open("wb") as err:
        observer = subprocess.Popen([pwsh, "-NoProfile", "-File", str(supervisor), "-InputLog", str(calls), "-OutputLog", str(snapshots), "-Seconds", "1800"], stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
        ready = time.monotonic() + 15
        while time.monotonic() < ready and observer.poll() is None:
            if snapshots.exists():
                with snapshots.open(encoding="utf-8") as stream: first = stream.readline()
                try: observer_ready = first.endswith("\n") and json.loads(first).get("kind") == "observer_ready"
                except json.JSONDecodeError: pass
                if observer_ready: break
            time.sleep(0.1)
        assert observer_ready and observer.poll() is None, "external observer not ready"
        for index in range(1, 2):
            report = evidence / f"round-{index:02d}.json"
            argv = [str(node), "node_modules/vitest/vitest.mjs", "run", "--config=vitest.engineering.config.ts", "--project=coding-evals", "--maxWorkers=1", "--reporter=json", "--outputFile", str(report)]
            started = time.monotonic()
            with (evidence / f"round-{index:02d}.stdout.log").open("wb") as stdout, (evidence / f"round-{index:02d}.stderr.log").open("wb") as stderr:
                process = subprocess.Popen(argv, cwd=root, env=env, stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
                watchdog = False
                try: code = process.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    watchdog = True
                    # 仅回收仍由本脚本持有句柄的测试根进程及其子树。
                    assert process.poll() is None
                    killed = subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                    (evidence / f"round-{index:02d}.watchdog-kill.log").write_bytes(killed.stdout + killed.stderr)
                    code = process.wait(timeout=15)
            data = json.loads(report.read_text(encoding="utf-8-sig")) if report.exists() else {}
            selected = [a for t in data.get("testResults", []) for a in t.get("assertionResults", []) if a.get("status") == "passed"]
            case_passed = code == 0 and not watchdog and data.get("success") is True and data.get("numTotalTests") == 8 and data.get("numPassedTests") == 8 and data.get("numPendingTests") == 0 and len(selected) == 8 and any(a.get("fullName") == "'python' Coding Kernel 跨文件验收 保留失败证据，写前建 checkpoint，修复后验证，并可完整恢复" for a in selected)
            observer_alive = observer.poll() is None
            accepted = case_passed and observer_alive
            item = {"projectRun": index, "nodePid": process.pid, "exitCode": code, "durationSeconds": time.monotonic() - started, "outerWatchdogFired": watchdog, "projectPassed": case_passed, "observerAlive": observer_alive, "accepted": accepted, "passed": data.get("numPassedTests"), "selectedOut": data.get("numPendingTests"), "report": report.name, "argv": argv}
            results.append(item)
            write(evidence / "progress.json", {"results": results, "originalRootCauseConfirmed": False})
            print(json.dumps(item, ensure_ascii=False), flush=True)
            if not accepted: break
finally:
    if observer is not None and observer.poll() is None:
        time.sleep(0.5)
    observer_natural_exit = observer is not None and observer.poll() is not None
    observer_terminated = False
    if observer is not None and not observer_natural_exit:
        observer.terminate()
        observer_terminated = True
        observer.wait(timeout=15)
    write(evidence / "batch-result.json", {"results": results, "plannedProjectRuns": 1, "executedProjectRuns": len(results), "expectedProjectCases": 8, "firstAnomalyStopped": bool(results and not results[-1]["accepted"]), "observerReady": observer_ready, "observerNaturalExit": observer_natural_exit, "observerStoppedByController": observer_terminated, "observerReturnCode": observer.returncode if observer is not None else None, "observerFailureIsProductFailure": False, "qualifiesAsEngineering": False, "originalRootCauseConfirmed": False, "interpretation": "Single full coding-evals project run only; passing is not repair evidence"})
if results and not results[-1]["accepted"]:
    raise SystemExit(1)
