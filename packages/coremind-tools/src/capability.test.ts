import { BUILTIN_TOOL_EFFECTS } from "coremind-config";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_CAPABILITIES,
  inferLegacyToolCapability,
  recoveryDispositionFor,
  resolveToolCapability,
} from "./capability.js";

describe("resolveToolCapability", () => {
  it("为全部内置工具提供稳定且正交的能力快照", () => {
    expect(BUILTIN_TOOL_CAPABILITIES).toEqual({
      read: pureLocalRead(),
      ls: pureLocalRead(),
      find: pureLocalRead(),
      grep: pureLocalRead(),
      git_status: pureLocalRead(),
      git_diff: pureLocalRead(),
      git_log: pureLocalRead(),
      edit: workspaceWrite("idempotent"),
      write: workspaceWrite("idempotent"),
      bash: {
        effect: "process",
        replay: "unknown",
        concurrency: "run_serial",
        checkpoint: "unsupported",
        durability: "critical",
      },
      "web-fetch": externalRead(),
      "web-search": externalRead(),
    });
  });

  it("能力注册表与旧 effect 兼容视图均不可在运行期改写", () => {
    expect(Object.isFrozen(BUILTIN_TOOL_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(BUILTIN_TOOL_EFFECTS)).toBe(true);
    for (const tool of Object.keys(BUILTIN_TOOL_CAPABILITIES)) {
      expect(
        Object.isFrozen(BUILTIN_TOOL_CAPABILITIES[tool as keyof typeof BUILTIN_TOOL_CAPABILITIES]),
      ).toBe(true);
      const effect = BUILTIN_TOOL_EFFECTS[tool as keyof typeof BUILTIN_TOOL_EFFECTS];
      expect(Object.isFrozen(effect)).toBe(true);
      expect(Object.isFrozen(effect.operations)).toBe(true);
      if (effect.pathFields) expect(Object.isFrozen(effect.pathFields)).toBe(true);
      if (effect.urlFields) expect(Object.isFrozen(effect.urlFields)).toBe(true);
    }
  });

  it("未知、缺字段与无法解析的声明统一走最严格 fallback", () => {
    const unknown = resolveToolCapability({ tool: "python_dynamic" });
    const incomplete = resolveToolCapability({
      tool: "registered_read",
      source: "registered",
      declaration: { effect: "none" },
    });
    const invalid = resolveToolCapability({
      tool: "registered_invalid",
      source: "registered",
      declaration: {
        effect: "none",
        replay: "sometimes" as "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
      },
    });
    const invalidSource = resolveToolCapability({
      tool: "registered_source",
      source: "extension" as "registered",
      declaration: pureLocalRead(),
    });

    for (const capability of [unknown, incomplete, invalid, invalidSource]) {
      expect(capability).toMatchObject({
        effect: "unknown",
        replay: "unknown",
        concurrency: "run_serial",
        checkpoint: "unsupported",
        durability: "critical",
        source: "fallback",
        resolution: "fallback",
      });
      expect(capability.issues.length).toBeGreaterThan(0);
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.issues)).toBe(true);
    }
  });

  it("自定义工具不能伪造 builtin 来源或覆盖内置能力快照", () => {
    const forgedCustom = resolveToolCapability({
      tool: "forged_builtin",
      source: "builtin",
      declaration: pureLocalRead(),
    });
    const forgedRead = resolveToolCapability({
      tool: "read",
      source: "builtin",
      declaration: workspaceWrite("unsafe"),
    });

    for (const capability of [forgedCustom, forgedRead]) {
      expect(capability).toMatchObject({
        effect: "unknown",
        source: "fallback",
        resolution: "fallback",
      });
      expect(capability.issues).toContain("capability_invalid:builtin_source");
    }
  });

  it("Config、Extension、Host 与入口的降权尝试失败关闭", () => {
    const baseline = resolveToolCapability({
      tool: "registered_writer",
      source: "registered",
      declaration: workspaceWrite("unsafe"),
      constraints: [
        {
          origin: "extension",
          capability: {
            effect: "none",
            replay: "safe",
            concurrency: "parallel",
            checkpoint: "none",
            durability: "ordinary",
          },
        },
      ],
    });

    expect(baseline).toMatchObject({
      effect: "unknown",
      replay: "unknown",
      source: "fallback",
      resolution: "fallback",
    });
    expect(baseline.issues).toEqual(
      expect.arrayContaining([
        "capability_downgrade:extension:effect",
        "capability_downgrade:extension:replay",
        "capability_downgrade:extension:concurrency",
        "capability_downgrade:extension:checkpoint",
        "capability_downgrade:extension:durability",
      ]),
    );
  });

  it("互不包含的 Effect 声明视为冲突而不是按风险数字覆盖", () => {
    const capability = resolveToolCapability({
      tool: "registered_writer",
      source: "registered",
      declaration: workspaceWrite("unsafe"),
      constraints: [{ origin: "host", capability: { effect: "network" } }],
    });

    expect(capability).toMatchObject({
      effect: "unknown",
      source: "fallback",
      resolution: "fallback",
    });
    expect(capability.issues).toContain("capability_conflict:host:effect");
  });

  it.each([
    { effect: "workspace" as const, checkpoint: "none" as const },
    { effect: "unknown" as const, checkpoint: "none" as const },
  ])("拒绝无法证明 Workspace 安全边界的 $effect/$checkpoint 组合", (combination) => {
    const capability = resolveToolCapability({
      tool: `registered_${combination.effect}`,
      source: "registered",
      declaration: {
        ...combination,
        replay: "unknown",
        concurrency: "run_serial",
        durability: "critical",
      },
    });

    expect(capability).toMatchObject({
      effect: "unknown",
      checkpoint: "unsupported",
      source: "fallback",
      resolution: "fallback",
    });
    expect(capability.issues).toContain(`capability_conflict:${combination.effect}:checkpoint`);
  });

  it("约束逐维收紧后仍重新校验跨维度安全性", () => {
    const capability = resolveToolCapability({
      tool: "read",
      constraints: [{ origin: "host", capability: { effect: "workspace" } }],
    });

    expect(capability).toMatchObject({
      effect: "unknown",
      checkpoint: "unsupported",
      source: "fallback",
      resolution: "fallback",
    });
    expect(capability.issues).toContain("capability_conflict:workspace:checkpoint");
  });

  it("旧声明同时跨越多个可变边界时不伪造单一 Effect", () => {
    const capability = inferLegacyToolCapability("legacy_mixed", {
      operations: ["write", "network"],
      reversible: false,
    });

    expect(capability).toMatchObject({
      effect: "unknown",
      replay: "unknown",
      checkpoint: "unsupported",
      source: "fallback",
      resolution: "fallback",
    });
  });

  it("网络读取不是纯本地读取，并要求未知恢复处置", () => {
    for (const tool of ["web-fetch", "web-search"]) {
      const capability = resolveToolCapability({ tool });
      expect(capability).toMatchObject({
        effect: "network",
        replay: "unknown",
        concurrency: "run_serial",
        checkpoint: "none",
      });
      expect(recoveryDispositionFor(capability)).toBe("requires_human");
    }
  });

  it("非本地 Effect 不能只凭 replay safe 推导为可安全重放", () => {
    const capability = resolveToolCapability({
      tool: "registered_network_read",
      source: "registered",
      declaration: {
        effect: "network",
        replay: "safe",
        concurrency: "run_serial",
        checkpoint: "none",
        durability: "critical",
      },
    });

    expect(recoveryDispositionFor(capability)).toBe("requires_proof");
  });
});

function pureLocalRead() {
  return {
    effect: "none" as const,
    replay: "safe" as const,
    concurrency: "parallel" as const,
    checkpoint: "none" as const,
    durability: "ordinary" as const,
  };
}

function workspaceWrite(replay: "idempotent" | "unsafe") {
  return {
    effect: "workspace" as const,
    replay,
    concurrency: "workspace_exclusive" as const,
    checkpoint: "required" as const,
    durability: "critical" as const,
  };
}

function externalRead() {
  return {
    effect: "network" as const,
    replay: "unknown" as const,
    concurrency: "run_serial" as const,
    checkpoint: "none" as const,
    durability: "critical" as const,
  };
}
