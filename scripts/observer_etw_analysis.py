"""临时 ETW 证据解码；解析通过不代表原故障复现或修复。"""

from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path
import hashlib
import re
import xml.etree.ElementTree as ET


FILETIME_EPOCH = 116444736000000000
GUIDS = {
    "68fdd900-4a3e-11d1-84f4-0000f80464e3": "header",
    "3d6fa8d0-fe05-11d0-9dda-00c04fd7ba7c": "process",
    "3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c": "thread",
    "90cbdc39-4a3e-11d1-84f4-0000f80464e3": "file",
    "3d6fa8d4-fe05-11d0-9dda-00c04fd7ba7c": "disk",
}
# 仅识别官方 MOF 的 class GUID、opcode 和字段形状，不固定本机版本号。
REQUIRED = {
    ("header", 0): ("EventsLost", "BuffersLost", "StartTime", "EndTime", "PerfFreq", "LogFileMode", "ReservedFlags"),
    **{("process", op): ("ProcessId", "ParentId", "ImageFileName") for op in (1, 2, 3, 4)},
    **{("thread", op): ("ProcessId", "TThreadId") for op in (1, 2, 3, 4)},
    ("thread", 36): ("NewThreadId", "OldThreadId", "OldThreadState", "OldThreadWaitReason"),
    ("thread", 50): ("TThreadId",),
    **{("file", op): ("FileObject", "FileName") for op in (0, 32, 35, 36)},
    ("file", 64): ("IrpPtr", "TTID", "FileObject", "OpenPath"),
    **{("file", op): ("IrpPtr", "TTID", "FileObject", "FileKey", "IoSize", "Offset") for op in (67, 68)},
    ("file", 76): ("IrpPtr", "NtStatus", "ExtraInfo"),
    **{("disk", op): ("Irp", "IssuingThreadId", "HighResResponseTime") for op in (10, 11)},
}


def _number(value):
    if not isinstance(value, (int, str)) or isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
        return int(text, 16 if text.lower().startswith("0x") else 10)
    except ValueError:
        return None


def _utc100(value):
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(?:Z|\+00:00)", value or "")
    if not match:
        return None
    date = datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    delta = date - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 10000000 + int((match[2] or "").ljust(9, "0")) // 100


def _encoding(path):
    with path.open("rb") as stream:
        prefix = stream.read(4)
    return "utf-16" if prefix.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"


def _events(path):
    # 二进制原件保留；仅接受显式 UTF-8 或工具带 BOM 的 UTF-16。
    with path.open("r", encoding=_encoding(path)) as stream:
        stack = []
        index = 0
        for action, node in ET.iterparse(stream, events=("start", "end")):
            if action == "start":
                stack.append(node)
                continue
            if node.tag.rsplit("}", 1)[-1] == "Event":
                by_name = defaultdict(list)
                for item in node.iter():
                    by_name[item.tag.rsplit("}", 1)[-1]].append(item)
                system = by_name.get("System", [None])[0]
                if system is None:
                    raise ValueError("Event 缺少 System")
                common = {item.tag.rsplit("}", 1)[-1]: item for item in system}
                provider = common.get("Provider")
                event_guid = by_name.get("EventGuid", [None])[0]
                guid = (event_guid.text if event_guid is not None else provider.get("Guid", "") if provider is not None else "") or ""
                data = {}
                duplicate = []
                for item in by_name.get("Data", []):
                    name = item.get("Name")
                    if name:
                        if name in data:
                            duplicate.append(name)
                        data[name] = "".join(item.itertext()).strip()
                time_node, execution = common.get("TimeCreated"), common.get("Execution")
                stamp = time_node.get("SystemTime", "") if time_node is not None else ""
                record = {"index": index, "guid": guid.strip("{}").lower(),
                          "opcode": _number(common["Opcode"].text) if "Opcode" in common else None,
                          "version": _number(common["Version"].text) if "Version" in common else None,
                          "timestamp": stamp, "utc100ns": _utc100(stamp), "data": data,
                          "header": dict(execution.attrib) if execution is not None else {},
                          "duplicateFields": duplicate}
                record["class"] = GUIDS.get(record["guid"], "unknown")
                index += 1
                stack[-2].remove(node) if len(stack) > 1 else None
                node.clear()
                yield record
            stack.pop()


def _key(event):
    return event["utc100ns"], event["index"]


def _path(value):
    return str(value).replace("/", "\\").rstrip("\x00").lower()


def _path_match(actual, wanted):
    actual, wanted = _path(actual), _path(wanted)
    if actual == wanted or actual.removeprefix("\\??\\") == wanted:
        return "exact"
    # NT 设备路径只能证明完整盘内 suffix；不能证明盘符或物理卷一致。
    suffix = wanted[2:] if re.match(r"^[a-z]:\\", wanted) else ""
    return "fullSuffixVolumeUnknown" if suffix and actual.endswith(suffix) else None


def _identity(event):
    return event["guid"], event["opcode"], event["version"], event["header"], event["data"]


def analyze_trace(xml_path: Path, summary_path: Path, expected: dict) -> dict:
    result = {"qualityPassed": False, "reasons": [], "unknown": [],
              "originalRootCauseConfirmed": False, "repairEstablished": False,
              "qualifiesAsEngineering": False, "kind": expected.get("kind"),
              "criticalThreadIds": {"state": "unknown", "reason": "未证明启动关键线程，不能用进程首线程或后台线程代替"},
              "clock": {"state": "unknown", "monotonicIsQpc": False,
                        "durationPrecision": "整数 100ns；不将单个 WaitReason 或重叠解释为因果"}}
    reasons, unknown = result["reasons"], result["unknown"]

    def reject(reason):
        if reason not in reasons:
            reasons.append(reason)

    try:
        xml_path, summary_path = Path(xml_path), Path(summary_path)
        result["sources"] = {}
        for name, path in (("xml", xml_path), ("summary", summary_path)):
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            result["sources"][name] = {"path": str(path), "sha256": digest, "encoding": _encoding(path)}
        summary = summary_path.read_text(encoding=_encoding(summary_path))
        losses = re.findall(r"(?im)^\s*Total\s+Events\s+Lost\s*:?\s*(\d+)\s*$", summary)
        result["loss"] = {"summaryTotalEventsLost": [int(item) for item in losses] or None}
        if not losses:
            reject("summary 的 Total Events Lost 字段未识别，实际格式尚待校准")
        elif any(int(item) for item in losses):
            reject("summary 报告事件丢失，失败窗口完整性未知")
        buffer_losses = re.findall(r"(?im)^\s*(?:Total\s+|Log\s+)Buffers\s+Lost\s*:?\s*(\d+)\s*$", summary)
        result["loss"]["summaryBufferLossValues"] = [int(item) for item in buffer_losses] or None
        if any(int(item) for item in buffer_losses):
            reject("summary 报告缓冲区丢失，失败窗口完整性未知")

        anchors = expected.get("anchors", {})
        before, after = anchors.get("before", {}), anchors.get("after", {})
        frequency = _number(before.get("qpcFrequency"))
        anchor_ok = bool(frequency and frequency > 0 and frequency == _number(after.get("qpcFrequency")))
        for anchor in (before, after):
            values = [_number(anchor.get(name)) for name in ("utcBeforeUnixNs", "utcAfterUnixNs", "qpcTicks")]
            anchor_ok = anchor_ok and all(value is not None for value in values)
            if all(value is not None for value in values):
                anchor_ok = anchor_ok and values[0] <= values[1]
            anchor_ok = anchor_ok and anchor.get("utcClock") == "GetSystemTimePreciseAsFileTime"
        anchor_ok = anchor_ok and before.get("qpcTicks", 0) < after.get("qpcTicks", 0)
        anchor_ok = anchor_ok and before.get("utcAfterUnixNs", 0) <= after.get("utcBeforeUnixNs", 0)
        result["clock"]["anchors"] = anchors
        if not anchor_ok:
            reject("QPC/精确 UTC 前后界未知或不一致；不能映射时钟")

        raw_path = Path(expected["rawXmlPath"]) if expected.get("rawXmlPath") else None
        if not raw_path:
            reject("缺少独立 -rts 原始时钟 XML，时钟来源未知")
        raw_events = _events(raw_path) if raw_path else iter(())
        headers, processes, lifecycle = [], [], []
        counts, shapes, invalid, clock_errors = Counter(), defaultdict(set), Counter(), Counter()
        valid_clock, total, first, last = 0, 0, None, None
        for event, raw in zip_longest(_events(xml_path), raw_events):
            if event is None:
                clock_errors["rawExtraEvents"] += 1
                continue
            total += 1
            label = f'{event["class"]}:{event["opcode"]}:v{event["version"]}'
            counts[label] += 1
            shapes[label].update(event["data"])
            needed = REQUIRED.get((event["class"], event["opcode"]))
            missing = set(needed or ()) - event["data"].keys()
            malformed = [name for name in needed or () if name in event["data"]
                         and (not event["data"][name] if name in ("ImageFileName", "OpenPath", "FileName") else _number(event["data"][name]) is None)]
            if event["duplicateFields"] or missing or malformed or needed and event["version"] is None:
                invalid[label] += 1
            if event["utc100ns"] is None:
                invalid["missingUtcTimestamp"] += 1
                continue
            first = event["utc100ns"] if first is None else min(first, event["utc100ns"])
            last = event["utc100ns"] if last is None else max(last, event["utc100ns"])
            if raw is None or _identity(event) != _identity(raw):
                clock_errors["rawMissingOrIdentityMismatch"] += 1
            elif anchor_ok:
                ticks = _number(raw["timestamp"])
                if ticks is None:
                    clock_errors["rawTimestampNotNumeric"] += 1
                else:
                    coherent = True
                    for anchor in (before, after):
                        delta = (ticks - anchor["qpcTicks"]) * 10000000
                        lower = anchor["utcBeforeUnixNs"] // 100 + delta // frequency - 1
                        upper = (anchor["utcAfterUnixNs"] + 99) // 100 + -(-delta // frequency) + 1
                        coherent = coherent and lower <= event["utc100ns"] <= upper
                    if coherent:
                        valid_clock += 1
                    else:
                        clock_errors["qpcUtcAnchorMismatch"] += 1
            if event["class"] == "header" and event["opcode"] == 0:
                headers.append(event)
            elif event["class"] == "process" and event["opcode"] in (1, 2, 3, 4):
                if _number(event["data"].get("ProcessId")) == expected.get("pid"):
                    processes.append(event)
            elif event["class"] == "thread" and event["opcode"] in (1, 2, 3, 4):
                lifecycle.append(event)

        result["raw"] = {"eventCount": total, "eventCounts": dict(counts),
                         "payloadFields": {key: sorted(value) for key, value in shapes.items()},
                         "invalidSchemas": dict(invalid), "firstEventUtc100ns": first, "lastEventUtc100ns": last}
        result["clock"].update(rawIdentityOrMappingErrors=dict(clock_errors), validatedEventCount=valid_clock)
        if invalid:
            reject("必需事件 payload 字段/UTC schema 缺失或重复")
        if clock_errors or not valid_clock:
            reject("normal/-rts XML 的事件身份或 QPC→UTC 映射未验证")
        if not headers:
            reject("ETL Header 未解码；频率、丢失计数、日志模式及首尾覆盖未知")
        result["traceHeaders"] = headers
        header_ok = bool(headers) and anchor_ok
        for header in headers:
            data = header["data"]
            values = {name: _number(data.get(name)) for name in REQUIRED[("header", 0)]}
            if any(value is None for value in values.values()):
                reject("ETL Header 必需整数统计未知")
                header_ok = False
                continue
            if values["EventsLost"] or values["BuffersLost"]:
                reject("ETL Header 报告事件/缓冲区丢失，完整性未知")
            mode = values["LogFileMode"]
            if not mode & 1 or mode & 2 or mode & 0x400:
                reject("未证明是无环形覆盖的顺序文件模式")
            if values["PerfFreq"] != frequency:
                reject("ETL PerfFreq 与父 QPC 频率不一致")
                header_ok = False
            if values["ReservedFlags"] != 1:
                reject("ETL Header 时钟类型不是已核验的 QPC")
                header_ok = False
            if anchor_ok and not (values["StartTime"] - FILETIME_EPOCH <= before["utcBeforeUnixNs"] // 100
                                  and values["EndTime"] - FILETIME_EPOCH >= (after["utcAfterUnixNs"] + 99) // 100):
                reject("ETL Header 首尾未覆盖完整前后 anchor 窗口")
                header_ok = False
        if header_ok and valid_clock and not clock_errors:
            result["clock"]["state"] = "QPC/UTC 事件对照已验证"

        process_start = process_end = None
        process_window = None
        if expected.get("kind") == "observer":
            controller = expected.get("startupResult", {}).get("controller", {})
            low = controller.get("popenBefore", {}).get("utcUnixMs")
            high = controller.get("popenAfterDeadlineCreated", {}).get("utcUnixMs")
            returned = controller.get("popenAfterDeadlineCreated", {}).get("returnedPid")
            creation = _number(expected.get("creationTime100ns"))
            cpu = controller.get("observerCpuBeforeCleanup", {})
            intended = expected.get("intent", {}).get("pwshExecutablePath", "")
            # 原 time.time_ns 毫秒记录的系统 tick 精度未知，只交叉观察，不伪造 ±1ms 界。
            coarse = {"reportedBeforeUtcUnixMs": low, "reportedAfterUtcUnixMs": high,
                      "state": "unknownPrecision", "usedAsIdentityGate": False,
                      "nativeCreationWithinReportedMilliseconds": low * 10000 <= creation - FILETIME_EPOCH < (high + 1) * 10000
                      if creation is not None and low is not None and high is not None else None}
            result["clock"]["coarsePopenUtcObservation"] = coarse
            result["clock"]["nativeCreationObservation"] = {
                "creationTime100ns": creation, "precision": "100ns 是单位，不代表已证明 UTC 精度",
                "withinPreciseOuterWindow": before["utcBeforeUnixNs"] // 100 <= creation - FILETIME_EPOCH <= (after["utcAfterUnixNs"] + 99) // 100
                if anchor_ok and creation is not None else None, "usedAsNarrowUtcGate": False}
            candidates = [event for event in processes if event["opcode"] == 1 and anchor_ok
                          and before["utcBeforeUnixNs"] // 100 <= event["utc100ns"] <= (after["utcAfterUnixNs"] + 99) // 100]
            cpu_identity = bool(cpu.get("state") == "observed" and cpu.get("returnedPid") == returned
                                and creation is not None and creation > 0 and _number(cpu.get("creationTime100ns")) == creation)
            matches_intent = bool(len(candidates) == 1 and intended
                                  and _number(candidates[0]["data"].get("ParentId")) == expected.get("parentPid")
                                  and _path(candidates[0]["data"].get("ImageFileName", "")).rsplit("\\", 1)[-1] == _path(intended).rsplit("\\", 1)[-1])
            if len(candidates) != 1 or returned != expected.get("pid") or not cpu_identity or not matches_intent:
                reject("returned PID/parent/C1 自有句柄身份/精确外层窗口不能唯一关联 ProcessStart；basename 仅关联意图")
            else:
                process_start = candidates[0]
                following = sorted((event for event in processes if event["opcode"] in (1, 2) and _key(event) > _key(process_start)), key=_key)
                if not following or following[0]["opcode"] != 2:
                    reject("目标 ProcessEnd 缺失或 PID 复用边界不明")
                else:
                    process_end = following[0]
                    start_key, end_key = (_number(event["data"].get("UniqueProcessKey")) for event in (process_start, process_end))
                    if not start_key or not end_key or start_key != end_key:
                        reject("ProcessStart/End 非零数值 UniqueProcessKey 缺失或不一致")
                    elif not (before["utcBeforeUnixNs"] // 100 <= process_end["utc100ns"] <= (after["utcAfterUnixNs"] + 99) // 100):
                        reject("ProcessEnd 未在本轮精确外层窗口内确认")
                    else:
                        process_window = (_key(process_start), _key(process_end))
        elif expected.get("kind") != "calibration":
            reject("未知诊断种类")

        instances, active, ambiguous = defaultdict(list), {}, []
        for event in sorted(lifecycle, key=_key):
            data, opcode = event["data"], event["opcode"]
            tid, pid = _number(data.get("TThreadId")), _number(data.get("ProcessId"))
            if tid is None or pid is None:
                reject("线程主体 ID 不是可验证整数")
                continue
            if opcode in (1, 3):
                if tid in active:
                    ambiguous.append(tid)
                    active[tid]["ambiguous"] = True
                item = {"tid": tid, "pid": pid, "start": event, "end": None, "ambiguous": tid in active}
                instances[tid].append(item)
                active[tid] = item
            elif tid in active and active[tid]["pid"] == pid:
                if opcode == 2:
                    active.pop(tid)["end"] = event
                else:
                    active[tid]["rundownEnd"] = event

        target = []
        for group in instances.values():
            for item in group:
                if item["pid"] != expected.get("pid"):
                    continue
                if expected.get("kind") == "calibration" and item["tid"] != expected.get("nativeThreadId"):
                    continue
                if process_window and not (process_window[0] <= _key(item["start"]) < process_window[1]):
                    continue
                target.append(item)
        if expected.get("kind") == "observer" and not process_window:
            target = []
        if not target or any(item["start"]["opcode"] != 1 or item["end"] is None or item["ambiguous"] for item in target):
            reject("目标新线程 Start/End 生存边界缺失、rundown 不能替代创建，或存在 TID 复用歧义")
        if expected.get("kind") == "calibration" and len(target) != 1:
            reject("校准 nativeThreadId 未唯一关联本轮新线程")
        trace_ends = [_number(header["data"].get("EndTime")) for header in headers]
        trace_end = min(trace_ends) - FILETIME_EPOCH if trace_ends and all(value is not None for value in trace_ends) else None
        if anchor_ok and any(not (before["utcBeforeUnixNs"] // 100 <= item["start"]["utc100ns"] <= (after["utcAfterUnixNs"] + 99) // 100)
                             or item["end"] is not None and (trace_end is None or item["end"]["utc100ns"] > trace_end) for item in target):
            reject("新线程 Start 超出动作锚，或 native ThreadEnd 未被完整 ETL 结束界覆盖")
        result["lifetime"] = {"expectedPid": expected.get("pid"), "processEvents": processes,
                              "matchedProcessStart": process_start, "matchedProcessEnd": process_end,
                              "imageIdentityLimit": "Process payload 的 basename 关联不证明执行文件完整路径或内存映像 hash",
                              "sourceIdentityPrerequisite": "调用方须验证原 driver 的全局 observer 全程持有同一 Popen/_handle，未 close 或按 PID 重开；本模块不 inspect 或另开句柄",
                              "bodyAfterAnchorIsNotNativeThreadExit": True,
                              "nativeThreadEndAfterBodyAnchorIds": [item["tid"] for item in target if anchor_ok and item["end"] is not None
                                                                     and item["end"]["utc100ns"] > (after["utcAfterUnixNs"] + 99) // 100],
                              "targetThreads": target, "ambiguousTids": sorted(set(ambiguous))}

        def thread_at(tid, event):
            matches = [item for item in instances.get(tid, []) if not item["ambiguous"]
                       and _key(item["start"]) <= _key(event)
                       and item["end"] is not None and _key(event) < _key(item["end"])]
            return matches[0] if len(matches) == 1 and any(matches[0] is item for item in target) else None

        scheduler, file_io, disk_io, ready_pairs = [], [], [], []
        pending_ready, objects, names, pending_irp = {}, {}, {}, defaultdict(list)
        object_reuse_unknown = set()
        clock_ready = result["clock"]["state"] != "unknown"
        for event in _events(xml_path):
            if event["utc100ns"] is None:
                continue
            data, opcode, klass = event["data"], event["opcode"], event["class"]
            if klass == "thread" and opcode in (36, 50):
                fields = ("OldThreadId", "NewThreadId") if opcode == 36 else ("TThreadId",)
                subjects = {field: thread_at(_number(data.get(field)), event) for field in fields}
                subjects = {field: item for field, item in subjects.items() if item is not None}
                if not subjects:
                    continue
                event["subjectInstances"] = {field: {"tid": item["tid"], "threadStartEventIndex": item["start"]["index"]} for field, item in subjects.items()}
                scheduler.append(event)
                for field, item in subjects.items():
                    instance = item["start"]["index"]
                    if field == "TThreadId":
                        pending_ready[instance] = event if instance not in pending_ready else None
                    elif field == "OldThreadId" and instance in pending_ready:
                        pending_ready[instance] = None
                    elif field == "NewThreadId" and instance in pending_ready:
                        ready = pending_ready.pop(instance)
                        if ready is not None and _key(ready) <= _key(event):
                            ready_pairs.append({"tid": item["tid"], "threadStartEventIndex": instance,
                                                "readyEventIndex": ready["index"], "scheduledEventIndex": event["index"],
                                                "observedReadyToSwitchIn100ns": event["utc100ns"] - ready["utc100ns"] if clock_ready else None})
            elif klass == "file":
                obj = _number(data.get("FileObject"))
                irp = _number(data.get("IrpPtr"))
                if irp and opcode != 76:
                    pending_irp[irp].append(None)
                if opcode == 64 and obj is not None:
                    if obj in objects:
                        object_reuse_unknown.add(obj)
                    objects[obj] = event
                elif opcode in (0, 32, 36) and obj is not None:
                    names[obj] = event
                elif opcode in (35, 66) and obj is not None:
                    objects.pop(obj, None)
                    names.pop(obj, None)
                    object_reuse_unknown.discard(obj)
                elif opcode in (67, 68):
                    thread = thread_at(_number(data.get("TTID")), event)
                    if thread is not None:
                        candidates = [item for item in (objects.get(obj), names.get(_number(data.get("FileKey")))) if item is not None]
                        paths = sorted({item["data"].get("OpenPath", item["data"].get("FileName", "")) for item in candidates})
                        event.update(subjectThreadStartEventIndex=thread["start"]["index"], pathCandidates=paths,
                                     pathState="uniqueWithinObservedObjectLifetime" if len(paths) == 1 and obj not in object_reuse_unknown else "unknownOrAmbiguous",
                                     pathMappingEvents=[item["index"] for item in candidates], completion=None)
                        file_io.append(event)
                        if irp:
                            pending_irp[irp][-1] = event
                elif opcode == 76:
                    irp = _number(data.get("IrpPtr"))
                    requests = pending_irp.pop(irp, [])
                    if len(requests) == 1 and requests[0] is not None:
                        begin = requests[0]
                        begin["completion"] = event
                        begin["observedOperation100ns"] = event["utc100ns"] - begin["utc100ns"] if clock_ready and _key(event) >= _key(begin) else None
            elif klass == "disk" and opcode in (10, 11) and thread_at(_number(data.get("IssuingThreadId")), event) is not None:
                # 原始 response time 单位及请求链未核验时，不生成磁盘耗时或 IO 致因结论。
                disk_io.append(event)

        result["scheduler"] = {"events": scheduler, "readyToSwitchInPairs": ready_pairs,
                               "unpairedReadyInstances": sorted(pending_ready), "stateOccupancy": "unknown"}
        result["io"] = {"fileEvents": file_io, "diskEvents": disk_io, "causalBlockingIo": "unknown"}
        if not any(event["opcode"] == 36 for event in scheduler) or not any(event["opcode"] == 50 for event in scheduler):
            reject("目标线程的 CSwitch/ReadyThread 未同时解码并关联")
        if expected.get("kind") == "calibration":
            wanted = expected.get("calibrationFile", "")
            device = expected.get("calibrationDevicePath", "")
            matches = []
            for event in file_io:
                if len(event["pathCandidates"]) != 1 or event["pathState"] != "uniqueWithinObservedObjectLifetime":
                    continue
                actual = event["pathCandidates"][0]
                match = _path_match(actual, wanted) if wanted else None
                if device and _path_match(actual, device) == "exact":
                    match = "exactDeviceMapping"
                if match:
                    event["calibrationPathMatch"] = match
                    matches.append(event)
            result["io"]["calibrationFileEvents"] = matches
            actions = expected.get("calibrationActions", [])
            requested = [action for action in actions if action.get("action") in ("read", "write")]
            if {action["action"] for action in requested} != {"read", "write"}:
                reject("校准实际 read/write 动作记录缺失")
            used = set()
            for action in requested:
                candidates = [event for event in matches if event["index"] not in used
                              and event["opcode"] == (67 if action["action"] == "read" else 68)
                              and event["calibrationPathMatch"] in ("exact", "exactDeviceMapping")
                              and _number(event["data"].get("Offset")) == action.get("offset")
                              and _number(event["data"].get("IoSize")) is not None
                              and _number(event["data"].get("IoSize")) >= action.get("size", 0) > 0
                              and event.get("completion") is not None
                              and _key(event) <= _key(event["completion"])
                              and _number(event["completion"]["data"].get("ExtraInfo")) == action.get("size")
                              and _number(event["completion"]["data"].get("NtStatus")) == 0]
                if len(candidates) == 1:
                    used.add(candidates[0]["index"])
                else:
                    reject(f'校准 {action["action"]} offset/返回字节/完成状态/文件卷身份未唯一验证')
            wait = next((action.get("anchor") for action in actions if action.get("action") == "wait"), None)
            woken = next((action.get("anchor") for action in actions if action.get("action") == "woken"), None)
            wait_pairs = []
            if wait and woken:
                low, high = wait.get("utcBeforeUnixNs", 0) // 100, (woken.get("utcAfterUnixNs", 0) + 99) // 100
                for pair in ready_pairs:
                    ready_event = next(event for event in scheduler if event["index"] == pair["readyEventIndex"])
                    scheduled = next(event for event in scheduler if event["index"] == pair["scheduledEventIndex"])
                    switched_out = [event for event in scheduler if event["opcode"] == 36
                                    and "OldThreadId" in event["subjectInstances"]
                                    and _number(event["data"].get("OldThreadState")) == 5
                                    and low <= event["utc100ns"] < ready_event["utc100ns"] <= scheduled["utc100ns"] <= high]
                    if switched_out:
                        wait_pairs.append({**pair, "waitingSwitchOutEventIndex": switched_out[-1]["index"]})
            result["scheduler"]["calibrationWaitWakePairs"] = wait_pairs
            if not wait_pairs:
                reject("校准 wait/woken 锚内未证明 Waiting switch-out→Ready→switch-in")
            result["criticalThreadIds"] = {"state": "calibrationOnly", "ids": [expected.get("nativeThreadId")], "reason": "仅自有校准 worker，不是观察器启动关键线程"}
        elif not file_io:
            reject("目标进程线程的文件 IO payload 未解码并关联")
        unknown.extend(["调度状态占比未计算；未配对事件不填区间", "仅 IO 访问、WaitReason 或时间重叠不能证明 IO 致因", "TSV 尚未按字节/offset/size/时间串联，观察器启动关键线程未知", "原 Popen 毫秒 UTC 的系统 tick 精度未知；GetTickCount64 deadline 未当 QPC 精确互减", "CPython join 完成不等于 native ThreadEnd；OS 退出以完整 ETL 事件为准"])
    except (OSError, ValueError, TypeError, KeyError, ET.ParseError) as error:
        reject(f"解码不完整：{type(error).__name__}: {error}")
    result["qualityPassed"] = not reasons
    return result
