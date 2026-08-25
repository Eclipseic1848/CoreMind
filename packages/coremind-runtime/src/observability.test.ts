import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createTelemetryConsentFact,
  createTelemetryEgressAuthorization,
  projectLocalObservability,
  TelemetryEgressController,
  type TelemetryExporter,
  TelemetryExporterError,
  telemetryFactPrefixFingerprint,
} from "./observability.js";
import type { RunStateRecord } from "./run-state.js";

describe("本地显性 Observability", () => {
  it("只从 Run Facts 重建运行、Turn、Call、错误、Context、Artifact、恢复与默认外传状态", () => {
    const records = fixtureRecords();

    const projection = projectLocalObservability(records, {
      runStatus: "paused",
      resumable: true,
      operationState: "paused",
      context: {
        budgets: 1,
        compactions: 1,
        failures: 0,
      },
      artifacts: { stored: 1, blocked: 0 },
      pendingControls: 1,
    });

    expect(projection).toMatchObject({
      schemaVersion: 1,
      localEnabled: true,
      derivedFromSequence: records.length,
      run: { status: "paused", operationState: "paused", resumable: true },
      turns: { started: 1, completed: 1, active: 0 },
      calls: { started: 1, completed: 1, failed: 0, active: 0 },
      context: { budgets: 1, compactions: 1, failures: 0 },
      artifacts: { stored: 1, blocked: 0 },
      sharedState: { pendingControls: 1 },
      telemetry: {
        mode: "DISABLED",
        source: "default",
        exporterLoaded: false,
        contentLevel: "metrics_only",
        queued: 0,
        handedOff: 0,
        failed: 0,
        dropped: 0,
        duplicates: 0,
      },
    });
    expect(projection.errors).toEqual([
      expect.objectContaining({ message: "可恢复错误", fatal: false }),
    ]);
  });

  it("legacy Facts 没有 telemetry 配置时显式标记 legacy 默认值", () => {
    const projection = projectLocalObservability([record(1, "start", { configName: "legacy" })]);

    expect(projection.telemetry).toMatchObject({
      mode: "DISABLED",
      source: "legacy_default",
      exporterLoaded: false,
    });
  });

  it("显式返回持久授权范围，并声明 handed-off 不等于 delivered", () => {
    const prefix = [
      record(1, "start", telemetryStart("FEEDBACK_ONLY")),
      eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" }),
    ];
    const projection = projectLocalObservability([
      ...prefix,
      record(
        3,
        "telemetry_consent",
        createTelemetryConsentFact({
          runId: "run-observability",
          consentId: "feedback-1",
          kind: "feedback",
          targetOrigin: "https://telemetry.example",
          contentLevel: "metrics_only",
          allowedFields: [],
          throughSequence: 2,
          factPrefixFingerprint: telemetryFactPrefixFingerprint(prefix, 2),
          grantedAt: "2026-08-24T00:00:01.000Z",
        }),
      ),
    ]);

    expect(projection.telemetry).toMatchObject({
      deliverySemantics: "best_effort_handoff_not_delivery",
      authorizedScopes: [
        {
          consentId: "feedback-1",
          runId: "run-observability",
          scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          kind: "feedback",
          targetOrigin: "https://telemetry.example",
          contentLevel: "metrics_only",
          allowedFields: [],
          throughSequence: 2,
          factPrefixFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
  });

  it("从终态与工具执行证据重建 Run 和 Call 耗时", () => {
    const projection = projectLocalObservability([
      record(1, "start", telemetryStart("DISABLED")),
      eventRecord(2, 1, {
        type: "tool_execution_evidence",
        agent: "main",
        tool: "read",
        callId: "call-1",
        execution: { durationMs: 7, exitCode: 0 },
      }),
      record(3, "finish", {
        outcome: { status: "succeeded", finishReason: "completed" },
        metrics: { durationMs: 19 },
      }),
    ]);

    expect(projection.run.durationMs).toBe(19);
    expect(projection.calls.durationMs).toBe(7);
  });
});

describe("Telemetry Egress", () => {
  it("DISABLED 不构造 Exporter、不读取凭据且不产生交付", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const readCredentials = vi.fn<() => Promise<Record<string, string>>>();
    const controller = new TelemetryEgressController({
      policy: { mode: "DISABLED" },
      createExporter,
      readCredentials,
    });

    const result = await controller.export(fixtureRecords());

    expect(createExporter).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "DISABLED",
      exporterLoaded: false,
      queued: 0,
      handedOff: 0,
      failed: 0,
      dropped: 0,
    });
  });

  it("内存 policy 未由持久配置 Fact 生效时拒绝构造 Exporter", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      createExporter,
    });

    const result = await controller.export(fixtureRecords());

    expect(createExporter).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handedOff: 0,
      failed: 1,
      lastFailure: "configuration_mismatch",
    });
  });

  it("FEEDBACK_ONLY 只发送持久 consent 覆盖的有界事实前缀", async () => {
    const exported: Array<{ sequence: number }> = [];
    const prefix = [
      record(1, "start", telemetryStart("FEEDBACK_ONLY")),
      eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" }),
    ];
    const records = [
      ...prefix,
      record(
        3,
        "telemetry_consent",
        createTelemetryConsentFact({
          runId: "run-observability",
          consentId: "feedback-1",
          kind: "feedback",
          targetOrigin: "https://telemetry.example",
          contentLevel: "metrics_only",
          allowedFields: [],
          throughSequence: 2,
          factPrefixFingerprint: telemetryFactPrefixFingerprint(prefix, 2),
          grantedAt: "2026-08-24T00:00:01.000Z",
        }),
      ),
      eventRecord(4, 2, { type: "agent_end", agent: "main", turnId: "turn-1" }),
    ];
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FEEDBACK_ONLY"),
      authorizeEgress,
      createExporter: () => ({
        export: async (item) => {
          exported.push({ sequence: item.sequence });
        },
      }),
    });

    const result = await controller.export(records);

    expect(exported.map((item) => item.sequence)).toEqual([1, 2]);
    expect(result).toMatchObject({ handedOff: 2, failed: 0, dropped: 0 });
  });

  it("consent 范围被篡改后指纹不匹配，拒绝构造 Exporter", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const prefix = [
      record(1, "start", telemetryStart("FEEDBACK_ONLY")),
      eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" }),
    ];
    const consent = createTelemetryConsentFact({
      runId: "run-observability",
      consentId: "feedback-tampered",
      kind: "feedback",
      targetOrigin: "https://telemetry.example",
      contentLevel: "metrics_only",
      allowedFields: [],
      throughSequence: 2,
      factPrefixFingerprint: telemetryFactPrefixFingerprint(prefix, 2),
      grantedAt: "2026-08-24T00:00:01.000Z",
    });
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FEEDBACK_ONLY"),
      createExporter,
      authorizeEgress,
    });

    const result = await controller.export([
      ...prefix,
      record(3, "telemetry_consent", { ...consent, throughSequence: 1 }),
    ]);

    expect(createExporter).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handedOff: 0,
      failed: 1,
      lastFailure: "feedback_consent_missing",
    });
  });

  it("伪造普通 UI event 不能代替持久 feedback consent", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FEEDBACK_ONLY"),
      createExporter,
    });

    const result = await controller.export([
      record(1, "start", telemetryStart("FEEDBACK_ONLY")),
      eventRecord(2, 1, {
        type: "telemetry_consent",
        consentId: "forged-ui-event",
        throughSequence: 2,
      }),
    ]);

    expect(createExporter).not.toHaveBeenCalled();
    expect(result.lastFailure).toBe("feedback_consent_missing");
  });

  it("FULL metrics_only 只发送允许的指标字段，不泄露正文、完整路径或凭据", async () => {
    const exported: unknown[] = [];
    const records = [
      record(1, "start", {
        ...telemetryStart("FULL"),
        initialPrompt: "绝密提示正文",
      }),
      eventRecord(2, 1, { type: "text_delta", agent: "main", delta: "绝密回复正文" }),
      eventRecord(3, 2, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        args: { path: "C:\\Users\\secret\\private.txt", apiKey: "sk-secret" },
        callId: "call-1",
      }),
    ];
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      createExporter: () => ({
        export: async (item) => {
          exported.push(item);
        },
      }),
    });

    const result = await controller.export(records);
    const serialized = JSON.stringify(exported);

    expect(result.handedOff).toBe(3);
    expect(serialized).not.toContain("绝密提示正文");
    expect(serialized).not.toContain("绝密回复正文");
    expect(serialized).not.toContain("private.txt");
    expect(serialized).not.toContain("sk-secret");
    expect(exported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-observability",
          sequence: 3,
          eventType: "tool_call",
        }),
      ]),
    );
  });

  it("脱敏器失败时记录失败关闭，不把原始字段交给 Exporter", async () => {
    const send = vi.fn();
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      redact: () => {
        throw new Error("注入脱敏失败");
      },
      createExporter: () => ({ export: send }),
    });

    const result = await controller.export(fixtureRecords("FULL"));

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handedOff: 0,
      failed: fixtureRecords("FULL").length,
      lastFailure: "redaction_failed",
    });
  });

  it("content 没有第二个独立持久 consent 时失败关闭", async () => {
    const send = vi.fn();
    const controller = new TelemetryEgressController({
      policy: {
        ...telemetryPolicy("FULL"),
        contentLevel: "content",
        allowedFields: ["start.initialPrompt"],
      },
      authorizeEgress,
      createExporter: () => ({ export: send }),
    });

    const result = await controller.export([
      record(1, "start", {
        ...telemetryStart("FULL", "content", ["start.initialPrompt"]),
        initialPrompt: "正文",
      }),
    ]);

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handedOff: 0,
      failed: 1,
      lastFailure: "content_consent_missing",
    });
  });

  it("content consent 必须把保留目的与撤销方式绑定进范围指纹", async () => {
    expect(() =>
      createTelemetryConsentFact({
        runId: "run-observability",
        consentId: "content-incomplete",
        kind: "content",
        targetOrigin: "https://telemetry.example",
        contentLevel: "content",
        allowedFields: ["start.initialPrompt"],
        grantedAt: "2026-08-24T00:00:01.000Z",
      }),
    ).toThrow("Telemetry consent Fact 已损坏");

    const consent = createTelemetryConsentFact({
      runId: "run-observability",
      consentId: "content-complete",
      kind: "content",
      targetOrigin: "https://telemetry.example",
      contentLevel: "content",
      allowedFields: ["start.initialPrompt"],
      retentionPurpose: "用户明确提交的诊断反馈，保留 7 天",
      revocationMethod: "由调用方撤销该 consent，并联系接收端删除已提交内容",
      grantedAt: "2026-08-24T00:00:01.000Z",
    });

    expect(consent).toMatchObject({
      retentionPurpose: expect.stringContaining("7 天"),
      revocationMethod: expect.stringContaining("撤销"),
      scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("feedback consent 不能跨 Run 或预授权尚未持久化的未来 Fact", async () => {
    const prefix = [record(1, "start", telemetryStart("FEEDBACK_ONLY"))];
    const consent = createTelemetryConsentFact({
      runId: "another-run",
      consentId: "feedback-future",
      kind: "feedback",
      targetOrigin: "https://telemetry.example",
      contentLevel: "metrics_only",
      allowedFields: [],
      throughSequence: 2,
      factPrefixFingerprint: telemetryFactPrefixFingerprint(
        [...prefix, eventRecord(2, 1, { type: "agent_start", agent: "main" })],
        2,
      ),
      grantedAt: "2026-08-24T00:00:01.000Z",
    });
    const createExporter = vi.fn<() => TelemetryExporter>();
    const result = await new TelemetryEgressController({
      policy: telemetryPolicy("FEEDBACK_ONLY"),
      authorizeEgress,
      createExporter,
    }).export([...prefix, record(2, "telemetry_consent", consent)]);

    expect(createExporter).not.toHaveBeenCalled();
    expect(result.lastFailure).toBe("feedback_consent_missing");
  });

  it("损坏的持久 Telemetry 配置不会被过滤降级后继续外传", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const configured = telemetryStart("FULL").telemetry as Record<string, unknown>;
    const result = await new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      createExporter,
    }).export([
      record(1, "start", {
        telemetry: {
          ...configured,
          allowedFields: [123],
        },
      }),
    ]);

    expect(createExporter).not.toHaveBeenCalled();
    expect(result.lastFailure).toBe("configuration_mismatch");
  });

  it("FULL 热配置只从持久配置 Fact 生效序列开始发送", async () => {
    const exported: Array<{ sequence: number }> = [];
    const records = [
      record(1, "start", telemetryStart("DISABLED")),
      eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" }),
      record(3, "telemetry_configuration", telemetryStart("FULL").telemetry),
      eventRecord(4, 2, { type: "agent_end", agent: "main", turnId: "turn-1" }),
    ];
    const result = await new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      createExporter: () => ({
        export: async (item) => {
          exported.push(item);
        },
      }),
    }).export(records);

    expect(exported.map((item) => item.sequence)).toEqual([4]);
    expect(result).toMatchObject({ handedOff: 1, failed: 0 });
  });

  it.each(["authorize", "credentials", "factory", "export"] as const)(
    "%s 挂起时由同一总时限收敛",
    async (stage) => {
      const never = () => new Promise<never>(() => {});
      const hanging = new TelemetryEgressController({
        policy: telemetryPolicy("FULL"),
        exportTimeoutMs: 20,
        shutdownTimeoutMs: 20,
        authorizeEgress: stage === "authorize" ? never : authorizeEgress,
        ...(stage === "credentials"
          ? { readCredentials: never }
          : { readCredentials: async () => ({}) }),
        createExporter:
          stage === "factory"
            ? never
            : () => ({ export: stage === "export" ? never : async () => {} }),
      });

      await expect(hanging.export(fixtureRecords("FULL"))).resolves.toMatchObject({
        failed: 1,
        lastFailure: "timeout",
      });
    },
  );

  it("shutdown 拒绝计入失败", async () => {
    const rejectedShutdown = new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      createExporter: () => ({
        export: async () => {},
        shutdown: async () => {
          throw new Error("shutdown rejected");
        },
      }),
    });
    await expect(rejectedShutdown.export(fixtureRecords("FULL"))).resolves.toMatchObject({
      failed: 1,
      lastFailure: "exporter_failed",
      shutdownTimedOut: false,
    });
  });

  it("独立 Node 进程在只有授权超时 timer 时仍会等待并收敛", () => {
    const runtimeDist = new URL("../dist/observability.js", import.meta.url).href;
    const script = `
      import { TelemetryEgressController } from ${JSON.stringify(runtimeDist)};
      const records = [{
        version: 1,
        runId: "run-child-timeout",
        sequence: 1,
        timestamp: "2026-08-24T00:00:00.000Z",
        kind: "start",
        payload: { telemetry: {
          schemaVersion: 1,
          mode: "FULL",
          endpointOrigin: "https://telemetry.example",
          contentLevel: "metrics_only",
          allowedFields: [],
          configuredAt: "2026-08-24T00:00:00.000Z"
        }}
      }];
      const result = await new TelemetryEgressController({
        policy: {
          mode: "FULL",
          endpoint: "https://telemetry.example/v1/traces",
          contentLevel: "metrics_only",
          allowedFields: []
        },
        exportTimeoutMs: 20,
        authorizeEgress: () => new Promise(() => {}),
        createExporter: () => ({ export: async () => {} })
      }).export(records);
      if (result.lastFailure !== "timeout") process.exitCode = 2;
      console.log(result.lastFailure);
    `;

    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("timeout");
  });

  it("没有精确 egress policy 收据时不构造 Exporter", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const result = await new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      createExporter,
    }).export(fixtureRecords("FULL"));

    expect(createExporter).not.toHaveBeenCalled();
    expect(result.lastFailure).toBe("egress_policy_missing");
  });

  it("egress policy 收据目标与配置 origin 不一致时失败关闭", async () => {
    const createExporter = vi.fn<() => TelemetryExporter>();
    const result = await new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress: () =>
        createTelemetryEgressAuthorization({
          targetOrigin: "https://other.example",
          resolvedAddresses: ["192.0.2.10"],
        }),
      createExporter,
    }).export(fixtureRecords("FULL"));

    expect(createExporter).not.toHaveBeenCalled();
    expect(result.lastFailure).toBe("egress_policy_denied");
    expect(() =>
      createTelemetryEgressAuthorization({
        targetOrigin: "https://telemetry.example",
        resolvedAddresses: ["not-an-ip"],
      }),
    ).toThrow("缺少合法 origin 或解析地址");
  });

  it.each(["dns", "tls", "http_401", "http_429", "timeout"] as const)(
    "%s 故障只更新交付投影，不改写输入 Facts",
    async (code) => {
      const records = fixtureRecords("FULL");
      const before = structuredClone(records);
      const controller = new TelemetryEgressController({
        policy: telemetryPolicy("FULL"),
        authorizeEgress,
        createExporter: () => ({
          export: async () => {
            throw new TelemetryExporterError(code, "注入故障");
          },
        }),
      });

      const result = await controller.export(records);

      expect(result.failed).toBeGreaterThan(0);
      expect(result.lastFailure).toBe(code);
      expect(records).toEqual(before);
    },
  );

  it("queue full、重复记录与 shutdown hang 都有界收敛", async () => {
    const exported: string[] = [];
    const first = eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" });
    const controller = new TelemetryEgressController({
      policy: telemetryPolicy("FULL"),
      authorizeEgress,
      queueLimit: 2,
      shutdownTimeoutMs: 20,
      createExporter: () => ({
        export: async (item) => {
          exported.push(item.identity);
        },
        shutdown: () => new Promise<void>(() => {}),
      }),
    });

    const result = await controller.export([
      record(1, "start", telemetryStart("FULL")),
      first,
      structuredClone(first),
      eventRecord(3, 2, { type: "agent_end", agent: "main", turnId: "turn-1" }),
    ]);

    expect(new Set(exported).size).toBe(exported.length);
    expect(result).toMatchObject({
      handedOff: 2,
      duplicates: 1,
      dropped: 1,
      shutdownTimedOut: true,
      failed: 1,
      lastFailure: "timeout",
    });
  });
});

function fixtureRecords(mode: "DISABLED" | "FULL" = "DISABLED"): RunStateRecord[] {
  return [
    record(1, "start", telemetryStart(mode)),
    eventRecord(2, 1, { type: "agent_start", agent: "main", turnId: "turn-1" }),
    eventRecord(3, 2, {
      type: "tool_call",
      agent: "main",
      tool: "read",
      args: { path: "notes.txt" },
      callId: "call-1",
      turnId: "turn-1",
    }),
    eventRecord(4, 3, {
      type: "tool_result",
      agent: "main",
      tool: "read",
      isError: false,
      callId: "call-1",
      turnId: "turn-1",
    }),
    eventRecord(5, 4, {
      type: "turn_end",
      agent: "main",
      turnId: "turn-1",
      requestsAnotherTurn: false,
    }),
    eventRecord(6, 5, { type: "error", message: "可恢复错误", fatal: false }),
  ];
}

function telemetryStart(
  mode: "DISABLED" | "FEEDBACK_ONLY" | "FULL",
  contentLevel: "metrics_only" | "content" = "metrics_only",
  allowedFields: string[] = [],
): Record<string, unknown> {
  return {
    configName: "observability",
    telemetry: {
      schemaVersion: 1,
      mode,
      endpointOrigin: mode === "DISABLED" ? undefined : "https://telemetry.example",
      contentLevel,
      allowedFields,
      configuredAt: "2026-08-24T00:00:00.000Z",
    },
  };
}

function telemetryPolicy(mode: "FEEDBACK_ONLY" | "FULL") {
  return {
    mode,
    endpoint: "https://telemetry.example/v1/traces?token=secret",
    contentLevel: "metrics_only" as const,
    allowedFields: [] as string[],
  };
}

function authorizeEgress({ endpointOrigin }: { endpointOrigin: string }) {
  return createTelemetryEgressAuthorization({
    targetOrigin: endpointOrigin,
    resolvedAddresses: ["192.0.2.10"],
  });
}

function eventRecord(
  sequence: number,
  traceSequence: number,
  event: Record<string, unknown>,
): RunStateRecord {
  return record(sequence, "event", {
    eventId: `event-${traceSequence}`,
    runId: "run-observability",
    sequence: traceSequence,
    timestamp: `2026-08-24T00:00:0${traceSequence}.000Z`,
    event,
  });
}

function record(sequence: number, kind: RunStateRecord["kind"], payload: unknown): RunStateRecord {
  return {
    version: 1,
    runId: "run-observability",
    sequence,
    timestamp: `2026-08-24T00:00:0${sequence}.000Z`,
    kind,
    payload,
  };
}
