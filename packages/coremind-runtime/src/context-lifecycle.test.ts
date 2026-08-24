import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextLifecycleManager } from "./context-lifecycle.js";

describe("ContextLifecycleManager capability 解析", () => {
  it("多个可信上限取安全交集而不是最大窗口", async () => {
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "long-horizon-model",
      resolvedAt: 123,
      request: emptyRequest(),
      capabilityCandidates: [
        candidate("locked_catalog", "verified", 1_000_000, 32_768),
        candidate("explicit_config", "declared", 131_072, 8_192),
        candidate("provider_metadata", "verified", 32_768, 4_096),
      ],
    });

    expect(result.capability).toEqual({
      providerId: "custom",
      modelId: "long-horizon-model",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      source: "provider_metadata",
      confidence: "declared",
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      resolvedAt: 123,
    });
    expect(result.evidence).toContainEqual({
      type: "safe_context_intersection",
      candidateCount: 3,
      effectiveContextWindow: 32_768,
      effectiveMaxOutputTokens: 4_096,
    });
  });

  it("custom 模型缺省窗口采用保守 fallback 时显式记录 assumed 证据", async () => {
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "unknown-model",
      resolvedAt: 456,
      request: emptyRequest(),
      capabilityCandidates: [
        candidate("conservative_fallback", "assumed", 32_768, 4_096, "custom", "unknown-model"),
      ],
    });

    expect(result.capability).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      source: "conservative_fallback",
      confidence: "assumed",
    });
    expect(result.evidence).toContainEqual({
      type: "assumed_context_window",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    });
  });

  it("候选顺序和解析时间不改变预算配置指纹", async () => {
    const manager = new ContextLifecycleManager();
    const first = await manager.prepare({
      providerId: "openai",
      modelId: "test-model",
      resolvedAt: 1,
      request: emptyRequest(),
      capabilityCandidates: [
        candidate("locked_catalog", "verified", 128_000, 16_384, "openai", "test-model"),
        candidate("explicit_config", "declared", 64_000, 8_192, "openai", "test-model"),
      ],
    });
    const second = await manager.prepare({
      providerId: "openai",
      modelId: "test-model",
      resolvedAt: 2,
      request: emptyRequest(),
      capabilityCandidates: [
        candidate("explicit_config", "declared", 64_000, 8_192, "openai", "test-model"),
        candidate("locked_catalog", "verified", 128_000, 16_384, "openai", "test-model"),
      ],
    });

    expect(first.capability.configFingerprint).toBe(second.capability.configFingerprint);
  });

  it("未知能力和 conflicting 候选在 Provider 调用前失败关闭", async () => {
    const manager = new ContextLifecycleManager();

    await expect(
      manager.prepare({
        providerId: "custom",
        modelId: "unknown-model",
        resolvedAt: 1,
        request: emptyRequest(),
        capabilityCandidates: [],
      }),
    ).rejects.toMatchObject({
      name: "ContextLifecycleError",
      code: "context_capability_conflict",
      pausable: true,
      reason: "unknown",
    });

    await expect(
      manager.prepare({
        providerId: "custom",
        modelId: "unknown-model",
        resolvedAt: 1,
        request: emptyRequest(),
        capabilityCandidates: [
          candidate("provider_metadata", "conflicting", 128_000, 8_192, "custom", "unknown-model"),
        ],
      }),
    ).rejects.toMatchObject({
      name: "ContextLifecycleError",
      code: "context_capability_conflict",
      pausable: true,
      reason: "conflicting",
    });
  });

  it("候选路由不属于本次 Provider/model 时拒绝共享全局窗口", async () => {
    await expect(
      new ContextLifecycleManager().prepare({
        providerId: "openai",
        modelId: "requested-model",
        resolvedAt: 1,
        request: emptyRequest(),
        capabilityCandidates: [
          candidate("provider_metadata", "verified", 128_000, 8_192, "openai", "different-model"),
        ],
      }),
    ).rejects.toMatchObject({
      code: "context_capability_conflict",
      reason: "route_mismatch",
    });
  });
});

describe("ContextLifecycleManager 请求预算", () => {
  it("完整计入输出、稳定前缀、工具 Schema、结构化输出、协议开销和安全余量", async () => {
    const messages = [user("继续完成长程任务")];
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "budget-model",
      resolvedAt: 1,
      capabilityCandidates: [
        candidate("explicit_config", "declared", 32_768, 4_096, "custom", "budget-model"),
      ],
      request: {
        ...emptyRequest(),
        messages,
        stablePrefix: "必须遵守权限与恢复边界。",
        toolSchemas: [{ name: "read_file", input: { path: "string" } }],
        structuredOutputSchema: { type: "object", required: ["answer"] },
        requestedMaxOutputTokens: 2_048,
        protocolOverheadTokens: 96,
        safetyMarginTokens: 512,
      },
    });

    expect(result.budget).toMatchObject({
      effectiveContextWindow: 32_768,
      reservedOutputTokens: 2_048,
      protocolOverheadTokens: 96,
      safetyMarginTokens: 512,
      estimator: "pi-agent-core-estimate-v1",
    });
    expect(result.budget.stablePrefixTokens).toBeGreaterThan(0);
    expect(result.budget.toolSchemaTokens).toBeGreaterThan(0);
    expect(result.budget.structuredOutputTokens).toBeGreaterThan(0);
    expect(result.budget.messageTokens).toBeGreaterThan(0);
    expect(result.budget.availableInputTokens).toBe(
      result.budget.effectiveContextWindow -
        result.budget.reservedOutputTokens -
        result.budget.stablePrefixTokens -
        result.budget.toolSchemaTokens -
        result.budget.structuredOutputTokens -
        result.budget.protocolOverheadTokens -
        result.budget.safetyMarginTokens,
    );
  });

  it("消息低于完整预算时逐对象保持不变且不制造压缩记录", async () => {
    const messages = [user("短请求")];
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "budget-model",
      resolvedAt: 1,
      capabilityCandidates: [
        candidate("explicit_config", "declared", 32_768, 4_096, "custom", "budget-model"),
      ],
      request: { ...emptyRequest(), messages },
    });

    expect(result.workingSet.messages).toBe(messages);
    expect(result.workingSet.compacted).toBe(false);
    expect(result.workingSet.tokens).toBe(result.budget.messageTokens);
    expect(result.compaction).toBeUndefined();
  });

  it("输出保留量同时受模型上限、本次请求和总窗口四分之一约束", async () => {
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "small-model",
      resolvedAt: 1,
      capabilityCandidates: [
        candidate("explicit_config", "declared", 8_000, 6_000, "custom", "small-model"),
      ],
      request: { ...emptyRequest(), requestedMaxOutputTokens: 3_000 },
    });

    expect(result.budget.reservedOutputTokens).toBe(2_000);
  });
});

describe("ContextLifecycleManager Working Set", () => {
  it("超预算时用确定性 TaskState 替换关闭前缀并原样保留最近完整 Turn", async () => {
    const latestTurn = user("继续 #69，下一步先验证压缩 lineage");
    const messages = [
      user(`旧问题-${"甲".repeat(8_000)}`),
      assistant(`旧回答-${"乙".repeat(8_000)}`),
      latestTurn,
    ];
    const taskState = {
      goal: "完成 CoreMind #69",
      constraints: ["必须保留审批、未知副作用与恢复边界"],
      approvals: ["仅允许离线验证，不调用真实 Provider"],
      uncertainEffects: ["当前没有未确认外部副作用"],
      activePlan: ["实现 ContextLifecycleManager", "验证 lineage"],
      modifiedFiles: ["packages/coremind-runtime/src/context-lifecycle.ts"],
      tests: ["Capability 与完整预算测试已通过"],
      incompleteTasks: ["接入 Runtime 与 Projection"],
      nextStep: "建立压缩 Ledger",
    };
    const result = await new ContextLifecycleManager().prepare({
      providerId: "custom",
      modelId: "compact-model",
      resolvedAt: 789,
      capabilityCandidates: [
        candidate("explicit_config", "declared", 2_000, 256, "custom", "compact-model"),
      ],
      request: {
        ...emptyRequest(),
        messages,
        taskState,
      },
    });

    expect(result.workingSet.compacted).toBe(true);
    expect(result.workingSet.messages).toHaveLength(2);
    expect(result.workingSet.messages[1]).toBe(latestTurn);
    expect(textOf(result.workingSet.messages[0])).toContain("CoreMind TaskState v1");
    expect(textOf(result.workingSet.messages[0])).toContain("完成 CoreMind #69");
    expect(textOf(result.workingSet.messages[0])).toContain("仅允许离线验证");
    expect(result.workingSet.tokens).toBeLessThanOrEqual(result.budget.availableInputTokens);
    expect(result.compaction).toMatchObject({
      reason: "threshold",
      removedMessages: 2,
      replacedRange: { start: 0, end: 2 },
      tokensBefore: result.budget.messageTokens,
      tokensAfter: result.workingSet.tokens,
      taskStateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      retainedTailFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("TaskState 与最近完整 Turn 已超预算时暂停且不截断不可删除集合", async () => {
    const latestTurn = user(`必须逐字保留-${"最近完整轮次".repeat(2_000)}`);
    await expect(
      new ContextLifecycleManager().prepare({
        providerId: "custom",
        modelId: "tiny-model",
        resolvedAt: 1,
        capabilityCandidates: [
          candidate("explicit_config", "declared", 1_024, 128, "custom", "tiny-model"),
        ],
        request: {
          ...emptyRequest(),
          messages: [latestTurn],
          taskState: {
            ...emptyTaskState(),
            goal: "保持最近完整轮次",
            constraints: ["不得截断"],
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "ContextLifecycleError",
      code: "context_budget_exhausted",
      pausable: true,
      reason: "undeletable_set_exceeds_budget",
    });
  });
});

describe("ContextLifecycleManager Artifact 校验", () => {
  it("发送前校验受控 Artifact 的真实文件、大小与 SHA-256", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "coremind-context-artifact-"));
    const artifactDirectory = path.join(workspaceRoot, ".coremind", "artifacts");
    const artifactPath = path.join(artifactDirectory, "artifact-a.log");
    const content = "完整工具输出";
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath, content, "utf8");
    try {
      const result = await prepareArtifactRequest(workspaceRoot, [
        {
          artifactId: "artifact-a",
          relativePath: ".coremind/artifacts/artifact-a.log",
          sizeBytes: Buffer.byteLength(content, "utf8"),
          sha256: sha256(content),
        },
      ]);

      expect(result.workingSet.compacted).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("Artifact 缺失、哈希不符或路径越界时统一暂停", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "coremind-context-artifact-fail-"));
    const artifactDirectory = path.join(workspaceRoot, ".coremind", "artifacts");
    const artifactPath = path.join(artifactDirectory, "artifact-a.log");
    const outsidePath = path.join(workspaceRoot, "outside.log");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath, "实际内容", "utf8");
    await writeFile(outsidePath, "越界内容", "utf8");
    const invalidReferences = [
      {
        artifactId: "missing",
        relativePath: ".coremind/artifacts/missing.log",
        sizeBytes: 1,
        sha256: sha256("x"),
      },
      {
        artifactId: "hash-mismatch",
        relativePath: ".coremind/artifacts/artifact-a.log",
        sizeBytes: Buffer.byteLength("实际内容", "utf8"),
        sha256: sha256("被篡改"),
      },
      {
        artifactId: "outside",
        relativePath: "outside.log",
        sizeBytes: Buffer.byteLength("越界内容", "utf8"),
        sha256: sha256("越界内容"),
      },
    ];
    try {
      for (const reference of invalidReferences) {
        await expect(prepareArtifactRequest(workspaceRoot, [reference])).rejects.toMatchObject({
          name: "ContextLifecycleError",
          code: "context_artifact_missing",
          pausable: true,
          reason: "artifact_missing",
          artifactId: reference.artifactId,
        });
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("ContextLifecycleManager Compaction Ledger", () => {
  it("连续 50 次压缩保持父链，并在深度阈值从 canonical messages 重建基线", async () => {
    const manager = new ContextLifecycleManager();
    const latestTurn = user("最近完整 Turn");
    let messages = [latestTurn];
    let canonicalMessages = [latestTurn];
    const previousCompactions: Array<
      NonNullable<Awaited<ReturnType<typeof prepareLedgerRequest>>["compaction"]>["ledgerEntry"]
    > = [];

    for (let index = 0; index < 50; index += 1) {
      const oldMessage = user(`历史-${index}-${"甲".repeat(8_000)}`);
      messages = [oldMessage, ...messages];
      canonicalMessages = [oldMessage, ...canonicalMessages];
      const result = await prepareLedgerRequest({
        manager,
        resolvedAt: index + 1,
        messages,
        canonicalMessages,
        previousCompactions,
      });
      expect(result.workingSet.compacted).toBe(true);
      expect(result.workingSet.messages.at(-1)).toBe(latestTurn);
      previousCompactions.push(result.compaction!.ledgerEntry);
      messages = result.workingSet.messages;
    }

    expect(previousCompactions).toHaveLength(50);
    expect(new Set(previousCompactions.map((entry) => entry.compactionId)).size).toBe(50);
    expect(
      previousCompactions.filter((entry) => entry.rebuiltFromCanonical).length,
    ).toBeGreaterThan(0);
    for (let index = 1; index < previousCompactions.length; index += 1) {
      expect(previousCompactions[index]?.parentCompactionId).toBe(
        previousCompactions[index - 1]?.compactionId,
      );
      expect(previousCompactions[index]?.lineageDepth).toBeLessThanOrEqual(8);
    }
  });

  it("Ledger 任一字段被篡改时在 Provider 请求前失败关闭", async () => {
    const first = await prepareLedgerRequest({
      manager: new ContextLifecycleManager(),
      resolvedAt: 1,
      messages: [user(`历史-${"甲".repeat(8_000)}`), user("最近 Turn")],
      canonicalMessages: [user(`历史-${"甲".repeat(8_000)}`), user("最近 Turn")],
      previousCompactions: [],
    });
    const corrupted = {
      ...first.compaction!.ledgerEntry,
      tokensAfter: first.compaction!.ledgerEntry.tokensAfter + 1,
    };

    await expect(
      prepareLedgerRequest({
        manager: new ContextLifecycleManager(),
        resolvedAt: 2,
        messages: first.workingSet.messages,
        canonicalMessages: [user("canonical")],
        previousCompactions: [corrupted],
        contextWindow: 1_000_000,
      }),
    ).rejects.toMatchObject({
      name: "ContextLifecycleError",
      code: "context_lineage_corrupt",
      pausable: false,
      reason: "lineage_corrupt",
    });
  });

  it("small→large 只放宽后续预算，不自动重注入 canonical archive", async () => {
    const canonicalMessages = [user(`历史-${"甲".repeat(8_000)}`), user("最近 Turn")];
    const small = await prepareLedgerRequest({
      manager: new ContextLifecycleManager(),
      resolvedAt: 1,
      messages: canonicalMessages,
      canonicalMessages,
      previousCompactions: [],
      contextWindow: 2_000,
    });
    const compactedMessages = small.workingSet.messages;
    const large = await prepareLedgerRequest({
      manager: new ContextLifecycleManager(),
      resolvedAt: 2,
      messages: compactedMessages,
      canonicalMessages,
      previousCompactions: [small.compaction!.ledgerEntry],
      contextWindow: 1_000_000,
      trigger: "model_switch",
    });

    expect(large.workingSet.messages).toBe(compactedMessages);
    expect(large.workingSet.compacted).toBe(false);
    expect(large.compaction).toBeUndefined();
  });
});

describe("ContextLifecycleManager 模型切换与动态占用", () => {
  it("按 1M→128K→32K→8K 的具体模型逐次重预算并保持 Working Set 有界", async () => {
    const manager = new ContextLifecycleManager();
    const canonicalMessages = [user(`长历史-${"甲".repeat(700_000)}`), user("最近 Turn")];
    let messages = canonicalMessages;
    const previousCompactions: Array<
      NonNullable<Awaited<ReturnType<typeof prepareSwitchRequest>>["compaction"]>["ledgerEntry"]
    > = [];
    const windows = [1_000_000, 128_000, 32_000, 8_000];
    const compacted: boolean[] = [];

    for (let index = 0; index < windows.length; index += 1) {
      const result = await prepareSwitchRequest({
        manager,
        contextWindow: windows[index]!,
        modelId: `switch-model-${windows[index]}`,
        resolvedAt: index + 1,
        messages,
        canonicalMessages,
        previousCompactions,
      });
      expect(result.workingSet.tokens).toBeLessThanOrEqual(result.budget.availableInputTokens);
      compacted.push(result.workingSet.compacted);
      if (result.compaction) previousCompactions.push(result.compaction.ledgerEntry);
      messages = result.workingSet.messages;
    }

    expect(compacted[0]).toBe(false);
    expect(compacted).toContain(true);
  });

  it("图片占用未知时失败关闭，显式计量时进入完整预算", async () => {
    const request = {
      ...emptyRequest(),
      messages: [imageUser()],
    };
    await expect(prepareDynamicRequest(request)).rejects.toMatchObject({
      code: "context_budget_exhausted",
      reason: "multimodal_occupancy_unknown",
    });

    const measured = await prepareDynamicRequest({
      ...request,
      multimodalOccupancyTokens: 512,
    });
    expect(measured.budget.multimodalTokens).toBe(512);
    expect(measured.budget.availableInputTokens).toBe(
      measured.budget.effectiveContextWindow -
        measured.budget.reservedOutputTokens -
        measured.budget.stablePrefixTokens -
        measured.budget.toolSchemaTokens -
        measured.budget.structuredOutputTokens -
        measured.budget.multimodalTokens -
        measured.budget.protocolOverheadTokens -
        measured.budget.safetyMarginTokens,
    );
  });

  it("工具 Schema 激增超过静态预算时暂停，不挤占最近 Turn", async () => {
    await expect(
      prepareDynamicRequest({
        ...emptyRequest(),
        messages: [user("最近 Turn")],
        toolSchemas: [{ schema: "x".repeat(30_000) }],
      }),
    ).rejects.toMatchObject({
      code: "context_budget_exhausted",
      reason: "budget_exhausted",
    });
  });
});

function candidate(
  source: "locked_catalog" | "explicit_config" | "provider_metadata" | "conservative_fallback",
  confidence: "verified" | "declared" | "assumed" | "conflicting",
  contextWindow: number,
  maxOutputTokens: number,
  providerId = "custom",
  modelId = "long-horizon-model",
) {
  return { providerId, modelId, contextWindow, maxOutputTokens, source, confidence };
}

function emptyRequest() {
  return {
    messages: [],
    stablePrefix: "",
    toolSchemas: [],
    protocolOverheadTokens: 0,
    safetyMarginTokens: 128,
    taskState: emptyTaskState(),
    artifactReferences: [],
    canonicalMessages: [],
    previousCompactions: [],
    lineageDepthLimit: 8,
    compactionTrigger: "threshold" as const,
  };
}

function emptyTaskState() {
  return {
    goal: "",
    constraints: [],
    approvals: [],
    uncertainEffects: [],
    activePlan: [],
    modifiedFiles: [],
    tests: [],
    incompleteTasks: [],
    nextStep: "",
    sourceFacts: {
      goal: [],
      constraints: [],
      approvals: [],
      uncertainEffects: [],
      activePlan: [],
      modifiedFiles: [],
      tests: [],
      incompleteTasks: [],
      nextStep: [],
    },
  };
}

function user(content: string) {
  return { role: "user" as const, content, timestamp: 1 };
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
    provider: "test",
    model: "test",
    stopReason: "stop" as const,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function textOf(message: { role: string; content: unknown } | undefined): string {
  if (message?.role !== "user") return "";
  return typeof message.content === "string" ? message.content : "";
}

async function prepareArtifactRequest(
  workspaceRoot: string,
  artifactReferences: Array<{
    artifactId: string;
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }>,
) {
  return new ContextLifecycleManager().prepare({
    providerId: "custom",
    modelId: "artifact-model",
    resolvedAt: 1,
    capabilityCandidates: [
      candidate("explicit_config", "declared", 32_768, 4_096, "custom", "artifact-model"),
    ],
    request: {
      ...emptyRequest(),
      messages: [user("读取受控 Artifact")],
      workspaceRoot,
      artifactReferences,
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function prepareSwitchRequest(options: {
  manager: ContextLifecycleManager;
  contextWindow: number;
  modelId: string;
  resolvedAt: number;
  messages: ReturnType<typeof user>[];
  canonicalMessages: ReturnType<typeof user>[];
  previousCompactions: unknown[];
}) {
  return options.manager.prepare({
    providerId: "custom",
    modelId: options.modelId,
    resolvedAt: options.resolvedAt,
    capabilityCandidates: [
      candidate(
        "explicit_config",
        "declared",
        options.contextWindow,
        Math.min(8_192, options.contextWindow - 1),
        "custom",
        options.modelId,
      ),
    ],
    request: {
      ...emptyRequest(),
      messages: options.messages,
      canonicalMessages: options.canonicalMessages,
      previousCompactions: options.previousCompactions,
      compactionTrigger: "model_switch",
    },
  });
}

async function prepareDynamicRequest(
  request: ReturnType<typeof emptyRequest> & Record<string, unknown>,
) {
  return new ContextLifecycleManager().prepare({
    providerId: "custom",
    modelId: "dynamic-model",
    resolvedAt: 1,
    capabilityCandidates: [
      candidate("explicit_config", "declared", 8_000, 1_000, "custom", "dynamic-model"),
    ],
    request,
  });
}

function imageUser() {
  return {
    role: "user" as const,
    content: [{ type: "image" as const, data: "base64-placeholder", mimeType: "image/png" }],
    timestamp: 1,
  };
}

async function prepareLedgerRequest(options: {
  manager: ContextLifecycleManager;
  resolvedAt: number;
  messages: ReturnType<typeof user>[];
  canonicalMessages: ReturnType<typeof user>[];
  previousCompactions: unknown[];
  contextWindow?: number;
  trigger?: "threshold" | "model_switch";
}) {
  const contextWindow = options.contextWindow ?? 2_000;
  return options.manager.prepare({
    providerId: "custom",
    modelId: "ledger-model",
    resolvedAt: options.resolvedAt,
    capabilityCandidates: [
      candidate(
        "explicit_config",
        "declared",
        contextWindow,
        Math.min(256, contextWindow - 1),
        "custom",
        "ledger-model",
      ),
    ],
    request: {
      ...emptyRequest(),
      messages: options.messages,
      canonicalMessages: options.canonicalMessages,
      previousCompactions: options.previousCompactions,
      compactionTrigger: options.trigger ?? "threshold",
    },
  });
}
