import { describe, expect, it } from "vitest";
import {
  createEffectReceiptBinding,
  type EffectReceiptBinding,
  fingerprintEffectReceiptValue,
  projectEffectReceiptBindings,
} from "./effect-receipt-binding.js";
import type { CoreMindEvent, EffectReceiptStatus } from "./events.js";

describe("EffectReceipt binding", () => {
  it("legacy started 后追加 bound 终态仍保持 legacy provenance", () => {
    const binding = createEffectReceiptBinding({
      runId: "run-1",
      turnId: "turn-1",
      agent: "main",
      callId: "call-1",
      tool: "write",
      args: { path: "article.md" },
      capability: {
        tool: "write",
        effect: "workspace",
        replay: "unknown",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
        source: "registered",
        resolution: "resolved",
        issues: [],
      },
    });
    const projection = projectEffectReceiptBindings([
      {
        type: "effect_receipt",
        idempotencyKey: "run-1:call-1",
        tool: "write",
        status: "started",
      },
      {
        type: "effect_receipt",
        idempotencyKey: "run-1:call-1",
        tool: "write",
        status: "unknown",
        agent: "main",
        callId: "call-1",
        turnId: "turn-1",
        binding,
      },
    ]);

    expect(projection).toEqual([
      {
        idempotencyKey: "run-1:call-1",
        status: "unknown",
        provenance: "legacy",
      },
    ]);
  });

  it("对 JSON 键顺序生成稳定的参数指纹", () => {
    expect(fingerprintEffectReceiptValue({ b: 1, a: [true, null] })).toBe(
      "51705a2c9eb3e7e410a58f696a770c3ac3885a0cf43eb7fc88f5e47c11d4d30d",
    );
  });

  it.each(["not_started", "committed", "unknown"] as const)(
    "合法 bound 链投影为 %s 并复制 binding",
    (terminalStatus) => {
      const binding = createBinding();
      const events =
        terminalStatus === "not_started"
          ? [receipt("not_started", binding)]
          : [receipt("started", binding), receipt(terminalStatus, binding)];

      const projection = projectEffectReceiptBindings(events);
      binding.argumentsFingerprint = "e".repeat(64);

      expect(projection).toEqual([
        {
          idempotencyKey: "run-1:step-1:call-1",
          status: terminalStatus,
          provenance: "bound",
          binding: expect.objectContaining({
            runId: "run-1",
            turnId: "turn-1",
            agent: "main",
            stepId: "step-1",
            callId: "call-1",
          }),
        },
      ]);
      expect(projection[0]?.binding?.argumentsFingerprint).not.toBe("e".repeat(64));
    },
  );

  it.each([
    ["初始 committed", [receipt("committed")]],
    ["初始 unknown", [receipt("unknown")]],
    ["started 后回到 not_started", [receipt("started"), receipt("not_started")]],
    [
      "committed 后再次 committed",
      [receipt("started"), receipt("committed"), receipt("committed")],
    ],
  ])("拒绝非法状态迁移：%s", (_name, events) => {
    expect(() => projectEffectReceiptBindings(events as ReturnType<typeof receipt>[])).toThrowError(
      expect.objectContaining({ code: "effect_receipt_conflict" }),
    );
  });

  it.each([
    ["version", { version: 2 }],
    ["run", { runId: "run-2" }],
    ["turn", { turnId: "turn-2" }],
    ["agent", { agent: "worker" }],
    ["step", { stepId: "step-2" }],
    ["call", { callId: "call-2" }],
    ["tool", { tool: "read" }],
    ["arguments fingerprint", { argumentsFingerprint: "short" }],
    ["capability fingerprint", { capabilityFingerprint: "short" }],
  ])("拒绝 binding 与事件不一致：%s", (_name, override) => {
    const invalid = { ...createBinding(), ...override } as unknown as EffectReceiptBinding;
    expect(() => projectEffectReceiptBindings([receipt("started", invalid)])).toThrowError(
      expect.objectContaining({ code: "effect_receipt_conflict" }),
    );
  });

  it("拒绝同一 ReceiptId 在终态改绑", () => {
    const binding = createBinding();
    expect(() =>
      projectEffectReceiptBindings([
        receipt("started", binding),
        receipt("unknown", { ...binding, argumentsFingerprint: "f".repeat(64) }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "effect_receipt_conflict" }));
  });

  it("拒绝 bound Receipt 在终态降级为 legacy", () => {
    expect(() =>
      projectEffectReceiptBindings([receipt("started", createBinding()), receipt("unknown")]),
    ).toThrowError(expect.objectContaining({ code: "effect_receipt_conflict" }));
  });
});

function createBinding(): EffectReceiptBinding {
  return createEffectReceiptBinding({
    runId: "run-1",
    turnId: "turn-1",
    agent: "main",
    stepId: "step-1",
    callId: "call-1",
    tool: "write",
    args: { path: "article.md" },
    capability: {
      tool: "write",
      effect: "workspace",
      replay: "unknown",
      concurrency: "workspace_exclusive",
      checkpoint: "required",
      durability: "critical",
      source: "registered",
      resolution: "resolved",
      issues: [],
    },
  });
}

function receipt(
  status: EffectReceiptStatus,
  binding?: EffectReceiptBinding,
): Extract<CoreMindEvent, { type: "effect_receipt" }> {
  return {
    type: "effect_receipt",
    idempotencyKey: "run-1:step-1:call-1",
    tool: "write",
    status,
    ...(binding
      ? {
          agent: "main",
          stepId: "step-1",
          callId: "call-1",
          turnId: "turn-1",
          binding,
        }
      : {}),
  };
}
