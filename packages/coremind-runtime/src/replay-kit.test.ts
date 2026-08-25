import { describe, expect, it } from "vitest";
import {
  createProviderRequestReplayFact,
  type ProviderRequestReplayFixture,
  ReplayKit,
} from "./replay-kit.js";
import type { RunStateRecord } from "./run-state.js";

describe("ReplayKit", () => {
  it("同一固定 Fact 与 Provider request fixture 可重复得到同一投影和指纹", () => {
    const fixture = {
      facts: replayFacts(),
      providerRequests: [requestFixture()],
    };

    const first = ReplayKit.replay(fixture);
    const second = ReplayKit.replay(structuredClone(fixture));

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      projection: {
        runId: "run-replay",
        status: "interrupted",
        context: {
          stablePrefixes: [{ agent: "main", fingerprint: "prefix-fingerprint" }],
        },
      },
      observation: {
        localEnabled: true,
        derivedFromSequence: 3,
        telemetry: { mode: "DISABLED", source: "default" },
      },
      providerRequests: [
        expect.objectContaining({
          requestId: "main:default:1",
          contextWorkingSetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    expect(first.factFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.replayFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("删除派生 Projection 后可从同一 Facts 重建相同 Run、Context、观测与恢复结论", () => {
    const fixture = { facts: replayFacts(), providerRequests: [requestFixture()] };
    const before = ReplayKit.replay(fixture);

    const rebuilt = ReplayKit.replay({
      facts: structuredClone(fixture.facts),
      providerRequests: [requestFixture()],
    });

    expect(rebuilt.projection).toEqual(before.projection);
    expect(rebuilt.observation).toEqual(before.observation);
    expect(rebuilt.projection.recovery).toEqual(before.projection.recovery);
    expect(rebuilt.replayFingerprint).toBe(before.replayFingerprint);
  });

  it("0.3.0/0.3.1 legacy Fact 缺少 telemetry 字段时明确降级，不伪造当前配置", () => {
    const result = ReplayKit.replay({
      facts: [record(1, "start", { configName: "legacy" })],
      providerRequests: [],
    });

    expect(result.observation.telemetry).toMatchObject({
      mode: "DISABLED",
      source: "legacy_default",
      exporterLoaded: false,
    });
  });

  it("Fact sequence 损坏时失败关闭", () => {
    const facts = replayFacts();
    facts[1] = { ...facts[1]!, sequence: 3 };

    expect(() => ReplayKit.replay({ facts, providerRequests: [] })).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
  });

  it("调用方 Fact 数组换序不改变 canonical 重放指纹", () => {
    const facts = replayFacts();
    const fixture = [requestFixture()];

    const ordered = ReplayKit.replay({ facts, providerRequests: fixture });
    const shuffled = ReplayKit.replay({
      facts: [facts[2]!, facts[0]!, facts[1]!],
      providerRequests: fixture,
    });

    expect(shuffled.factFingerprint).toBe(ordered.factFingerprint);
    expect(shuffled.replayFingerprint).toBe(ordered.replayFingerprint);
  });

  it("请求正文、工具 schema 或 Working Set 漂移时拒绝重放", () => {
    const changed = { ...requestFixture(), messages: [{ role: "user", content: "已漂移" }] };

    expect(() => ReplayKit.replay({ facts: replayFacts(), providerRequests: [changed] })).toThrow(
      "Provider request fixture 与持久 Working Set 指纹不一致",
    );
  });
});

function replayFacts(): RunStateRecord[] {
  return [
    record(1, "start", {
      configName: "replay",
      telemetry: {
        schemaVersion: 1,
        mode: "DISABLED",
        contentLevel: "metrics_only",
        allowedFields: [],
        configuredAt: "2026-08-24T00:00:00.000Z",
      },
    }),
    record(2, "event", {
      eventId: "event-1",
      runId: "run-replay",
      sequence: 1,
      timestamp: "2026-08-24T00:00:01.000Z",
      event: { type: "context_prefix", agent: "main", fingerprint: "prefix-fingerprint" },
    }),
    record(3, "event", {
      eventId: "event-2",
      runId: "run-replay",
      sequence: 2,
      timestamp: "2026-08-24T00:00:02.000Z",
      event: {
        type: "provider_request",
        agent: "main",
        ...createProviderRequestReplayFact(requestFixture()),
      },
    }),
  ];
}

function requestFixture(): ProviderRequestReplayFixture {
  return {
    requestId: "main:default:1",
    providerId: "probe",
    modelId: "probe-model",
    messages: [{ role: "user", content: "固定请求", timestamp: 1_777_000_000_000 }],
    stablePrefix: "固定系统前缀",
    toolSchemas: [{ name: "read", parameters: { type: "object" } }],
    capabilityFingerprint: "capability-sha256",
  };
}

function record(sequence: number, kind: RunStateRecord["kind"], payload: unknown): RunStateRecord {
  return {
    version: 1,
    runId: "run-replay",
    sequence,
    timestamp: `2026-08-24T00:00:0${sequence - 1}.000Z`,
    kind,
    payload,
  };
}
