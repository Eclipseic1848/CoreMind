from contextlib import contextmanager
from pathlib import Path
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
import xml.etree.ElementTree as ET


PROFILE = "CoreMindObserver.Light"
MINIMUM_FREE_BYTES = 1024 ** 3


class TraceEvidenceError(RuntimeError):
    pass


class CommandEvidenceError(TraceEvidenceError):
    def __init__(self, record, error):
        super().__init__("command receipt could not be written: " + repr(error))
        self.record = record


def _write(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def _record_error(path, error, original_error=None):
    try:
        _write(path, {"state": "unknown", "errorType": type(error).__name__, "error": str(error),
                     "originalExceptionPreserved": original_error is not None, "repairEstablished": False})
    except Exception:
        pass


def _clock_anchor():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    counter, frequency = ctypes.c_longlong(), ctypes.c_longlong()
    utc = wintypes.FILETIME()
    kernel.QueryPerformanceCounter.argtypes = [ctypes.POINTER(ctypes.c_longlong)]
    kernel.QueryPerformanceFrequency.argtypes = [ctypes.POINTER(ctypes.c_longlong)]
    kernel.GetSystemTimePreciseAsFileTime.argtypes = [ctypes.POINTER(wintypes.FILETIME)]
    if not kernel.QueryPerformanceFrequency(ctypes.byref(frequency)) or frequency.value <= 0:
        raise ctypes.WinError(ctypes.get_last_error())
    kernel.GetSystemTimePreciseAsFileTime(ctypes.byref(utc))
    utc_before = (((utc.dwHighDateTime << 32) | utc.dwLowDateTime) - 116444736000000000) * 100
    anchor = {"utcBeforeUnixNs": utc_before, "monotonicBeforeSeconds": time.monotonic(),
              "utcClock": "GetSystemTimePreciseAsFileTime"}
    if not kernel.QueryPerformanceCounter(ctypes.byref(counter)):
        raise ctypes.WinError(ctypes.get_last_error())
    anchor.update(qpcTicks=counter.value, qpcFrequency=frequency.value, monotonicAfterSeconds=time.monotonic())
    kernel.GetSystemTimePreciseAsFileTime(ctypes.byref(utc))
    anchor["utcAfterUnixNs"] = (((utc.dwHighDateTime << 32) | utc.dwLowDateTime) - 116444736000000000) * 100
    return anchor


def _current_creation():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    values = [wintypes.FILETIME() for _ in range(4)]
    if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *(ctypes.byref(value) for value in values)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime


def _device_path(path):
    query = ctypes.WinDLL("kernel32", use_last_error=True).QueryDosDeviceW
    query.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    query.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    drive = path.drive
    if not drive or not query(drive, buffer, len(buffer)):
        raise TraceEvidenceError("calibration DOS-to-device path mapping unavailable")
    return buffer.value + str(path)[len(drive):]


def _run(directory, label, command, timeout):
    record = {"command": [str(arg) for arg in command], "timeoutSeconds": timeout,
              "utcBeforeUnixNs": time.time_ns(), "monotonicBeforeSeconds": time.monotonic()}
    with (directory / (label + ".stdout.log")).open("xb") as out, (directory / (label + ".stderr.log")).open("xb") as err:
        try:
            completed = subprocess.run(record["command"], stdout=out, stderr=err, timeout=timeout,
                                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            record.update(exitCode=completed.returncode, state="completed")
        except (OSError, subprocess.TimeoutExpired) as error:
            record.update(state="unknown", errorType=type(error).__name__, error=str(error))
    record.update(utcAfterUnixNs=time.time_ns(), monotonicAfterSeconds=time.monotonic())
    try:
        _write(directory / (label + ".json"), record)
    except Exception as error:
        raise CommandEvidenceError(record, error) from error
    return record


def _ok(record):
    return record.get("state") == "completed" and record.get("exitCode") == 0


def _capabilities(directory, profile):
    if os.name != "nt":
        raise TraceEvidenceError("ETW diagnostic requires Windows")
    system = Path(os.environ["SystemRoot"]) / "System32"
    tools = {"wpr": system / "wpr.exe", "tracerpt": system / "tracerpt.exe"}
    profile_root = ET.fromstring(profile.read_bytes())
    selected = profile_root.find(".//Profile[@Id='CoreMindObserver.Light.File']")
    collector = profile_root.find(".//SystemCollector")
    if selected is None or collector is None:
        raise TraceEvidenceError("ETW profile metadata is unavailable")
    admin = bool(ctypes.WinDLL("shell32").IsUserAnAdmin())
    metadata = {"profilePath": str(profile), "profileSelector": str(profile) + "!" + PROFILE,
                "profileSha256": hashlib.sha256(profile.read_bytes()).hexdigest(),
                "profileName": selected.attrib["Name"], "collectorName": collector.attrib["Name"],
                "adminTokenIsUserAnAdmin": admin,
                "tools": {name: {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                          for name, path in tools.items()},
                "diagnosticOnly": True, "notOriginalReproduction": True,
                "traceMayPerturbTiming": True, "qualifiesAsEngineering": False,
                "repairEstablished": False}
    _write(directory / "capabilities.json", metadata)
    (directory / "profile.wprp").write_bytes(profile.read_bytes())
    if not admin:
        raise TraceEvidenceError("ETW kernel tracing requires an elevated admin token")
    profiles = _run(directory, "profiles", [tools["wpr"], "-profiles", profile], 30)
    details = _run(directory, "profile-details", [tools["wpr"], "-profiledetails", metadata["profileSelector"], "-filemode"], 30)
    if not _ok(profiles) or not _ok(details):
        raise TraceEvidenceError("ETW profile validation failed")
    return {**tools, **metadata}


class _Trace:
    def __init__(self, directory, tools):
        self.directory, self.tools = directory, tools
        directory.mkdir()
        self.instance = "CoreMindObserver-" + "-".join((os.environ.get("GITHUB_RUN_ID", "local"),
            os.environ.get("GITHUB_RUN_ATTEMPT", "0"), str(os.getpid()), uuid.uuid4().hex))
        self.owned = False
        self.attempted = False
        self.before = None
        self.finished = False
        self.status_index = 0
        self.result = {"instance": self.instance, "state": "unknown", "reasons": [],
                       "traceMayPerturbTiming": True, "repairEstablished": False,
                       "diskBefore": shutil.disk_usage(directory)._asdict()}

    def _status(self):
        self.status_index += 1
        label = "status-" + str(self.status_index)
        result = _run(self.directory, label, [self.tools["wpr"], "-status", "profiles", "collectors", "-details",
                                             "-instancename", self.instance], 30)
        if self.attempted and not self.owned and _ok(result):
            raw = (self.directory / (label + ".stdout.log")).read_bytes()
            # 未知 start 只能在精确实例的状态同时证明 profile 和 collector 后认领。
            texts = [raw.decode(encoding, errors="replace") for encoding in ("utf-8", "utf-16-le")]
            self.owned = any(self.tools["profileName"] in value and self.tools["collectorName"] in value for value in texts)
            if self.owned:
                self.result["ownershipBasis"] = "exact-instance-status-identifies-source-profile-and-collector"
        self.result["ownershipConfirmed"] = self.owned
        return result

    def start(self):
        self.result.update(diskBefore=shutil.disk_usage(self.directory)._asdict(),
            diskAdmissionMinimumFreeBytes=MINIMUM_FREE_BYTES,
            diskAdmissionInterpretation="Conservative short-window ETL and dual-XML budget; not a maximum-size or complete-coverage guarantee")
        self.result["diskAdmissionPassed"] = self.result["diskBefore"]["free"] >= MINIMUM_FREE_BYTES
        if not self.result["diskAdmissionPassed"]:
            self.result["reasons"].append("less than 1 GiB free before ETW arm")
            self.result["ownedSessionMayRemain"] = False
            self.finished = True
            _write(self.directory / "capture-result.json", self.result)
            raise TraceEvidenceError("insufficient disk space before ETW arm")
        temporary = self.directory / "recording"
        temporary.mkdir()
        self.attempted = True
        try:
            result = _run(self.directory, "start", [self.tools["wpr"], "-start", self.tools["profileSelector"],
                "-filemode", "-recordtempto", temporary, "-instancename", self.instance], 30)
            self.result["start"] = result
            self.owned = _ok(result)
            if not self.owned:
                raise TraceEvidenceError("ETW start did not confirm success")
            self.result["ownershipBasis"] = "start-exit-0"
            self.result["preWindowStatusQuerySucceeded"] = _ok(self._status())
            self.result["normalizedProfileCollectorIdentityVerified"] = False
            if not self.result["preWindowStatusQuerySucceeded"]:
                raise TraceEvidenceError("ETW exact-instance pre-window status query failed")
            self.before = _clock_anchor()
            _write(self.directory / "armed.json", {"instance": self.instance, "anchor": self.before,
                                                  "ownershipConfirmed": True})
        except BaseException as start_error:
            if isinstance(start_error, CommandEvidenceError) and start_error.record["command"][1] == "-start":
                self.result["start"] = start_error.record
                self.owned = _ok(start_error.record)
                if self.owned:
                    self.result["ownershipBasis"] = "start-exit-0-receipt-write-failed"
            # start 结果未知时不操作其他会话；仅查询随机实例并尝试收尾确证自有会话。
            try:
                self.finish()
            except BaseException as error:
                _record_error(self.directory / "start-cleanup-failed.json", error, start_error)
            raise

    def finish(self):
        if self.finished:
            return self.result
        self.finished = True
        try:
            self.result["status"] = self._status() if self.attempted else {"state": "not-started"}
        except Exception as error:
            self.result["reasons"].append("status unknown: " + repr(error))
        if not self.owned:
            self.result["reasons"].append("trace ownership is unknown; stop/cancel not attempted")
            self.result["ownedSessionMayRemain"] = "unknown" if self.attempted else False
            _write(self.directory / "capture-result.json", self.result)
            return self.result
        etl = self.directory / "trace.etl"
        try:
            stopped = _run(self.directory, "stop", [self.tools["wpr"], "-stop", etl, "-skipPdbGen",
                                                     "-instancename", self.instance], 60)
            if not _ok(stopped):
                raise TraceEvidenceError("ETW stop did not confirm success")
            self.owned = False
            if not etl.is_file() or etl.stat().st_size == 0:
                raise TraceEvidenceError("ETW trace file is missing or empty")
            self.result["etlSizeBytes"] = etl.stat().st_size
            exported = _run(self.directory, "export", [self.tools["tracerpt"], "-l", etl, "-of", "XML", "-o",
                self.directory / "events.xml", "-summary", self.directory / "summary.txt", "-export", self.directory / "schema.man"], 120)
            raw = _run(self.directory, "export-raw", [self.tools["tracerpt"], "-l", etl, "-of", "XML", "-o",
                self.directory / "events.raw.xml", "-rts"], 120)
            if not _ok(exported) or not _ok(raw):
                raise TraceEvidenceError("strict ETW XML export failed")
            self.result["state"] = "exported"
        except Exception as error:
            if isinstance(error, CommandEvidenceError) and error.record.get("command", [None, None])[1] == "-stop" and _ok(error.record):
                self.owned = False
            self.result["reasons"].append(repr(error))
        finally:
            if self.owned:
                try:
                    self.result["cancel"] = _run(self.directory, "cancel", [self.tools["wpr"], "-cancel",
                                                        "-instancename", self.instance], 30)
                    self.owned = not _ok(self.result["cancel"])
                except Exception as error:
                    self.result["reasons"].append("owned-instance cancel unknown: " + repr(error))
            self.result["ownedSessionMayRemain"] = self.owned
            try:
                self.result["diskAfter"] = shutil.disk_usage(self.directory)._asdict()
            except OSError as error:
                self.result["reasons"].append("disk space unavailable: " + repr(error))
            _write(self.directory / "capture-result.json", self.result)
        return self.result


def _finish_and_analyze(trace, expected):
    try:
        expected["anchors"] = {"before": trace.before, "after": _clock_anchor()}
        expected.update(rawXmlPath=str(trace.directory / "events.raw.xml"),
                        schemaPath=str(trace.directory / "schema.man"), tracePath=str(trace.directory / "trace.etl"))
        _write(trace.directory / "expected.json", expected)
    finally:
        capture = trace.finish()
    if capture["state"] != "exported":
        raise TraceEvidenceError("ETW capture/export unavailable; cause remains unknown")
    from observer_etw_analysis import analyze_trace
    analysis = analyze_trace(trace.directory / "events.xml", trace.directory / "summary.txt", expected)
    _write(trace.directory / "analysis.json", analysis)
    if analysis.get("qualityPassed") is not True:
        raise TraceEvidenceError("ETW evidence quality failed: " + repr(analysis.get("reasons", [])))


def _calibration(directory, tools):
    trace = _Trace(directory, tools)
    expected = {"kind": "calibration", "pid": os.getpid(), "parentPid": os.getppid(),
                "creationTime100ns": _current_creation(), "notOriginalReproduction": True,
                "calibrationFile": str((directory / "known-io.bin").resolve()), "calibrationActions": []}
    expected["calibrationDevicePath"] = _device_path(Path(expected["calibrationFile"]))
    ready, release = threading.Event(), threading.Event()
    errors = []

    def worker():
        try:
            expected["nativeThreadId"] = threading.get_native_id()
            expected["calibrationActions"].append({"action": "wait", "anchor": _clock_anchor()})
            ready.set()
            if not release.wait(5):
                raise TraceEvidenceError("calibration wakeup was not observed")
            expected["calibrationActions"].append({"action": "woken", "anchor": _clock_anchor()})
            until = time.perf_counter() + 0.03
            while time.perf_counter() < until:
                pass
            with Path(expected["calibrationFile"]).open("xb", buffering=0) as stream:
                for offset in (0, 4096):
                    size = stream.write(b"C" * 4096)
                    expected["calibrationActions"].append({"action": "write", "offset": offset, "size": size})
                stream.flush()
                os.fsync(stream.fileno())
            with Path(expected["calibrationFile"]).open("rb", buffering=0) as stream:
                data = stream.read()
            if data != b"C" * 8192:
                raise TraceEvidenceError("calibration file readback mismatch")
            expected["calibrationActions"].append({"action": "read", "offset": 0, "size": len(data)})
        except BaseException as error:
            errors.append({"errorType": type(error).__name__, "error": str(error)})

    trace.start()
    body_error = None
    try:
        thread = threading.Thread(target=worker, name="etw-calibration-not-original-repro", daemon=True)
        thread.start()
        try:
            if not ready.wait(5):
                raise TraceEvidenceError("calibration worker did not become ready")
            time.sleep(0.05)
            release.set()
            thread.join(5)
            if thread.is_alive() or errors:
                raise TraceEvidenceError("calibration worker did not complete: " + repr(errors))
        finally:
            release.set()
            if thread.is_alive():
                thread.join(5)
    except BaseException as error:
        body_error = error
        raise
    finally:
        expected["workerErrors"] = errors
        try:
            _finish_and_analyze(trace, expected)
        except BaseException as error:
            _record_error(directory / "calibration-analysis-failed.json", error, body_error)
            if body_error is None:
                raise


@contextmanager
def record_observer_trace(evidence, profile_path):
    directory = evidence / "etw"
    directory.mkdir()
    trace = None
    body_error = None
    try:
        tools = _capabilities(directory, profile_path.resolve())
        _calibration(directory / "calibration", tools)
        trace = _Trace(directory / "observer", tools)
        trace.start()
        try:
            yield
        except BaseException as error:
            body_error = error
            raise
        finally:
            # 原 owner 的完整 finally 已结束，才读取结果、采锚和启动任何收尾命令。
            try:
                startup = json.loads((evidence / "startup-result.json").read_text(encoding="utf-8"))
                intent = json.loads((evidence / "intent.json").read_text(encoding="utf-8"))
                controller = startup["controller"]
                expected = {"kind": "observer", "pid": controller["popenAfterDeadlineCreated"]["returnedPid"],
                    "parentPid": os.getpid(), "creationTime100ns": controller["observerCpuBeforeCleanup"].get("creationTime100ns"),
                    "startupResult": startup, "intent": intent,
                    "startupTracePath": str(evidence / startup["startupTrace"])}
                _finish_and_analyze(trace, expected)
            except BaseException as error:
                _record_error(trace.directory / "trace-analysis-failed.json", error, body_error)
                try:
                    trace.finish()
                except BaseException as cleanup_error:
                    _record_error(trace.directory / "trace-cleanup-failed.json", cleanup_error, body_error or error)
                if body_error is None:
                    raise
    except BaseException as error:
        try:
            _write(directory / "diagnostic-failed.json", {"state": "unknown", "errorType": type(error).__name__,
                "error": str(error), "originalStartupExceptionPreserved": body_error is not None,
                "observerFailureIsProductFailure": False, "repairEstablished": False})
        except Exception:
            pass
        raise
