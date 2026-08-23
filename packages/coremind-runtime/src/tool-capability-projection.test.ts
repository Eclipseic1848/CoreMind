import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToolCapability } from "coremind-tools";
import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import type { RunStateRecord } from "./run-state.js";
import {
  projectToolCapabilities,
  projectToolCapabilitiesFromRecords,
} from "./tool-capability-projection.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/tool-capability",
);

describe("Tool Capability 投影", () => {
  it.each(["legacy-0.3.0.json", "legacy-0.3.1.json"])(
    "%s 缺失 Capability 时显式投影为 legacy/unknown",
    (fixture) => {
      const records = JSON.parse(
        readFileSync(path.join(fixtureDir, fixture), "utf8"),
      ) as RunStateRecord[];

      expect(projectToolCapabilitiesFromRecords(records)).toEqual([
        expect.objectContaining({
          provenance: "legacy",
          recoveryDisposition: "requires_human",
          capability: expect.objectContaining({
            effect: "unknown",
            replay: "unknown",
            source: "fallback",
            resolution: "fallback",
          }),
        }),
      ]);
    },
  );

  it("当前 Fact 直接投影同一份 Capability 与恢复处置", () => {
    const capability = resolveToolCapability({ tool: "read" });
    const events: CoreMindEvent[] = [
      {
        type: "tool_call",
        agent: "main",
        tool: "read",
        args: { path: "notes.txt" },
        callId: "call-current",
      },
      {
        type: "capability_resolved",
        agent: "main",
        tool: "read",
        callId: "call-current",
        capability,
        recoveryDisposition: "replay_safe",
      },
    ];

    expect(projectToolCapabilities(events)).toEqual([
      {
        agent: "main",
        callId: "call-current",
        tool: "read",
        capability,
        recoveryDisposition: "replay_safe",
        provenance: "current",
      },
    ]);
  });

  it("不同 Agent 复用同一 CallId 时仍保持能力隔离", () => {
    const read = resolveToolCapability({ tool: "read" });
    const write = resolveToolCapability({ tool: "write" });
    const events: CoreMindEvent[] = [
      { type: "tool_call", agent: "reader", tool: "read", args: {}, callId: "shared" },
      {
        type: "capability_resolved",
        agent: "reader",
        tool: "read",
        callId: "shared",
        capability: read,
        recoveryDisposition: "replay_safe",
      },
      { type: "tool_call", agent: "writer", tool: "write", args: {}, callId: "shared" },
      {
        type: "capability_resolved",
        agent: "writer",
        tool: "write",
        callId: "shared",
        capability: write,
        recoveryDisposition: "requires_proof",
      },
    ];

    expect(projectToolCapabilities(events)).toEqual([
      expect.objectContaining({
        agent: "reader",
        tool: "read",
        capability: read,
        provenance: "current",
      }),
      expect.objectContaining({
        agent: "writer",
        tool: "write",
        capability: write,
        provenance: "current",
      }),
    ]);
  });

  it("同一 Call 身份出现冲突 Capability Fact 时失败关闭", () => {
    const read = resolveToolCapability({ tool: "read" });
    const write = resolveToolCapability({ tool: "write" });
    const events: CoreMindEvent[] = [
      { type: "tool_call", agent: "main", tool: "read", args: {}, callId: "conflict" },
      {
        type: "capability_resolved",
        agent: "main",
        tool: "read",
        callId: "conflict",
        capability: read,
        recoveryDisposition: "replay_safe",
      },
      {
        type: "capability_resolved",
        agent: "main",
        tool: "write",
        callId: "conflict",
        capability: write,
        recoveryDisposition: "requires_proof",
      },
    ];

    expect(() => projectToolCapabilities(events)).toThrowError(
      expect.objectContaining({ code: "tool_capability_conflict" }),
    );
  });

  it("历史记录中同一 Call 身份更换工具时不能被去重吞掉", () => {
    const events: CoreMindEvent[] = [
      { type: "tool_call", agent: "main", tool: "read", args: {}, callId: "reused" },
      { type: "tool_call", agent: "main", tool: "write", args: {}, callId: "reused" },
    ];

    expect(() => projectToolCapabilities(events)).toThrowError(
      expect.objectContaining({ code: "tool_capability_conflict" }),
    );
  });
});
