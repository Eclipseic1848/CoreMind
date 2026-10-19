import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunBudgetController,
  resolveRuntimeLimits,
} from "../packages/coremind-runtime/src/budget.js";
import {
  assertCertificationSucceeded,
  certificationChildBudget,
  checkCertificationChildRun,
  classifyCertificationApprovalRejection,
  createCertificationEvidence,
  createCertificationFailure,
  inspectCandidateManifest,
  recordCertificationFailure,
  upsertCertificationRecord,
  validateCertificationApproval,
  verifyCandidateArtifact,
} from "./provider-certification.mjs";

describe("真实父子认证链的离线反例", () => {
  it.each([
    [
      { agent: "parent", tool: "delegate", args: { target: "worker", task: "TASK " } },
      "delegate_task_mismatch",
    ],
    [
      { agent: "parent", tool: "delegate", args: { target: "other", task: "TASK" } },
      "delegate_target_mismatch",
    ],
    [
      { agent: "worker", tool: "write", args: { path: "other", content: "MARKER" } },
      "write_path_mismatch",
    ],
    [
      { agent: "worker", tool: "write", args: { path: "marker.txt", content: "MARKER\n" } },
      "write_content_mismatch",
    ],
    [{ agent: "parent", tool: "write", args: {} }, "unexpected_agent_or_tool"],
    [
      {
        agent: "PRIVATE-CANARY-SECRET",
        tool: "PRIVATE-CANARY-SECRET",
        args: { secret: "PRIVATE-CANARY-SECRET" },
      },
      "unexpected_agent_or_tool",
    ],
    [
      { agent: "parent", tool: "delegate", args: { target: "worker", task: "TASK" } },
      "unclassified_rejection",
    ],
    [
      { agent: "worker", tool: "write", args: { path: "marker.txt", content: "MARKER" } },
      "unclassified_rejection",
    ],
  ])("拒绝分类只返回固定枚举：%s", (request, reason) => {
    const result = classifyCertificationApprovalRejection(request, {
      task: "TASK",
      markerPath: "marker.txt",
      marker: "MARKER",
    });
    expect(result).toBe(reason);
    expect(result).not.toContain("PRIVATE-CANARY-SECRET");
  });

  it("完整链和真实文件副作用才可通过", async () => {
    await withChildFixture(async (context) => {
      await expect(checkCertificationChildRun(context)).resolves.toMatchObject({
        passed: true,
        parentProviderCalls: 1,
        childProviderCalls: 1,
        childToolCompleted: true,
        structuredResultSha256: createHash("sha256")
          .update(JSON.stringify(context.result.childRuns.nodes[0].result))
          .digest("hex"),
      });
    });
  });

  it("文件缺失仍报告认证链失败，不被 ENOENT 遮蔽", async () => {
    await withChildFixture(async (context) => {
      await rm(context.markerFile);
      await expect(checkCertificationChildRun(context)).rejects.toThrow(
        "真实父子 Agent 产品链不完整",
      );
      const snapshot = failureFixture(context);
      snapshot.events.push(
        { type: "provider_request" },
        {
          type: "turn_end",
          inputTokens: 8,
          outputTokens: 2,
          costUsd: 0.02,
        },
      );
      expect(createCertificationFailure(snapshot)).toMatchObject({
        status: "failed",
        child: { markerStatus: "missing", delegationToolCalled: true, childToolCompleted: true },
        usage: { completeness: "partial", costUsdObserved: 0.02, inputTokensObserved: 8 },
      });
    });
  });

  it.each(["delegate", "write"])("%s 的错误回执不能被认作工具完成", async (tool) => {
    await withChildFixture(async (context) => {
      for (const event of context.events) {
        if (event.type === "tool_result" && event.tool === tool) event.isError = true;
      }
      await expect(checkCertificationChildRun(context)).rejects.toThrow(
        "真实父子 Agent 产品链不完整",
      );
    });
  });

  it.each(["delegate", "write"])("未调用 %s 时，即使文件存在也必须失败", async (tool) => {
    await withChildFixture(async (context) => {
      context.events = context.events.filter((event) => event.tool !== tool);
      await expect(checkCertificationChildRun(context)).rejects.toThrow(
        "真实父子 Agent 产品链不完整",
      );
    });
  });

  it("审批拒绝和工具错误分别留证，文件存在仍不能掩盖失败", async () => {
    await withChildFixture(async (context) => {
      context.approvalsAllowed = 1;
      context.approvalsDenied = 1;
      for (const event of context.events) {
        if (event.type === "tool_result" && event.tool === "write") event.isError = true;
      }
      await expect(checkCertificationChildRun(context)).rejects.toThrow(
        "真实父子 Agent 产品链不完整",
      );
      expect(createCertificationFailure(failureFixture(context)).child).toMatchObject({
        approvalsAllowed: 1,
        approvalsDenied: 1,
        toolErrors: 1,
        childToolCompleted: false,
      });
    });
  });

  it("审批拒绝保留固定分类，未知分类不进入失败摘要", () => {
    const context = childFixture();
    Object.assign(context, { lastApprovalRejection: "delegate_task_mismatch" });
    expect(createCertificationFailure(failureFixture(context)).child).toMatchObject({
      lastApprovalRejection: "delegate_task_mismatch",
    });
    Object.assign(context, { lastApprovalRejection: "PRIVATE-CANARY-SECRET" });
    const evidence = createCertificationFailure(failureFixture(context));
    expect(evidence.child.lastApprovalRejection).toBe("unknown");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-CANARY-SECRET");
  });

  it.each([
    "未 join",
    "Child 失败",
    "仍有后代",
    "未静止",
    "无结构化结果",
    "多个 Child",
    "marker 不符",
  ])("%s 仍受原门槛拦截", async (scenario) => {
    await withChildFixture(async (context) => {
      const node = context.result.childRuns.nodes[0];
      if (scenario === "未 join") node.status = "running";
      if (scenario === "Child 失败") node.outcome.status = "failed";
      if (scenario === "仍有后代") context.result.childRuns.activeDescendants = 1;
      if (scenario === "未静止") context.result.childRuns.quiescent = false;
      if (scenario === "无结构化结果") Object.assign(node, { result: undefined });
      if (scenario === "多个 Child") context.result.childRuns.nodes.push(node);
      if (scenario === "marker 不符") await writeFile(context.markerFile, "wrong", "utf8");
      await expect(checkCertificationChildRun(context)).rejects.toThrow(
        "真实父子 Agent 产品链不完整",
      );
    });
  });

  it("其他文件读取错误保留原 I/O 错误并记为不可用", async () => {
    await withChildFixture(async (context) => {
      context.markerFile = path.dirname(context.markerFile);
      await expect(checkCertificationChildRun(context)).rejects.toMatchObject({ code: "EISDIR" });
      expect(createCertificationFailure(failureFixture(context)).child.markerStatus).toBe(
        "unavailable",
      );
    });
  });
});

describe("失败认证的有界独立证据", () => {
  it.each(["child-cancel", "multi-turn", "abort", "long-context", "auth-error", "evidence"])(
    "%s 失败不得沿用先前成功 Child 的现场",
    (stage) => {
      const snapshot = failureFixture(childFixture());
      snapshot.stage = stage;
      expect(createCertificationFailure(snapshot)).toMatchObject({ stage, child: null });
    },
  );

  it("只保留白名单元数据和固定事实，不含 canary 正文、参数、异常、路径或密钥", () => {
    const canary = "PRIVATE-CANARY-SECRET";
    const child = childFixture(canary);
    Object.assign(child.result, { transcript: canary, error: canary });
    Object.assign(child.result.childRuns.nodes[0], {
      agentName: canary,
      result: { secret: canary },
    });
    Object.assign(child.events[0], { prompt: canary, args: { path: canary }, error: canary });
    child.result.outcome.status = canary;
    child.markerStatus = canary;
    const snapshot = failureFixture(child);
    Object.assign(snapshot.approval, { credentialEnv: canary, key: canary });
    const evidence = createCertificationFailure(snapshot);
    const json = JSON.stringify(evidence);
    expect(json).not.toContain(canary);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(4096);
    expect(evidence).toMatchObject({
      kind: "provider-certification-failure",
      evidenceLevel: "diagnostic-only",
      status: "failed",
      stage: "child-validate",
      commit: "a".repeat(40),
      child: { parentOutcome: "unknown", markerStatus: "unknown", structuredResultPresent: true },
    });
    expect(createCertificationFailure({ ...snapshot, stage: canary })).toMatchObject({
      stage: "unknown",
      child: null,
    });
  });

  it("缺失或坏用量保持 unknown/null，保留有效的部分费用而不声称是完整账单", () => {
    const snapshot = failureFixture();
    snapshot.events.push(
      { type: "provider_request" },
      {
        type: "turn_end",
        inputTokens: -1,
        outputTokens: NaN,
        costUsd: Infinity,
      },
    );
    expect(createCertificationFailure(snapshot).usage).toMatchObject({
      completeness: "unknown",
      providerCallsObserved: 1,
      turnsObserved: 1,
      completeUsageTurns: 0,
      inputTokensObserved: null,
      outputTokensObserved: null,
      costUsdObserved: null,
    });
    snapshot.events.push({ type: "turn_end", costUsd: 0.03 }, { type: "retry", scope: "provider" });
    expect(createCertificationFailure(snapshot).usage).toMatchObject({
      completeness: "partial",
      costUsdObserved: 0.03,
      inputTokensObserved: null,
      outputTokensObserved: null,
      completeUsageTurns: 0,
      retriesObserved: 1,
    });
  });

  it("成功写入的一条固定前缀日志和独立 JSON 文件一致", async () => {
    await withChildFixture(async (context) => {
      const file = path.join(path.dirname(context.markerFile), "failure.json");
      const logs: string[] = [];
      await recordCertificationFailure(failureFixture(context), {
        writeLog: (line: string) => logs.push(line),
        writeArtifact: (json: string) => writeFile(file, json, "utf8"),
      });
      const json = await readFile(file, "utf8");
      expect(logs).toEqual([`COREMIND_CERTIFICATION_FAILURE ${json.trimEnd()}`]);
      expect(JSON.parse(json)).toMatchObject({
        status: "failed",
        evidenceLevel: "diagnostic-only",
      });
    });
  });

  it.each(["日志", "异步日志", "文件", "两者", "观察"])(
    "%s 输出异常不替换原失败，真实临时目录仍清理",
    async (fault) => {
      const original = new Error("原认证失败");
      let directory = "";
      let artifactCalled = false;
      let logCalled = false;
      const operation = withChildFixture(async (context) => {
        directory = path.dirname(context.markerFile);
        try {
          throw original;
        } catch (error) {
          const snapshot =
            fault === "观察"
              ? new Proxy(failureFixture(context), {
                  get() {
                    throw new Error("观察故障");
                  },
                })
              : failureFixture(context);
          await recordCertificationFailure(snapshot, {
            writeLog: () => {
              logCalled = true;
              if (fault === "日志" || fault === "两者") throw new Error("日志故障");
              if (fault === "异步日志") return Promise.reject(new Error("异步日志故障"));
            },
            writeArtifact: async () => {
              artifactCalled = true;
              if (fault === "文件" || fault === "两者") throw new Error("文件故障");
            },
          });
          throw error;
        }
      });
      await expect(operation).rejects.toBe(original);
      expect(logCalled).toBe(fault !== "观察");
      expect(artifactCalled).toBe(fault !== "观察");
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

function failureFixture(child?: ReturnType<typeof childFixture>) {
  return {
    version: "1.2.0",
    commit: "a".repeat(40),
    runtimeArtifactSha256: "b".repeat(64),
    candidateArtifactSha256: "c".repeat(64),
    runtimeDigest: `sha256:${"d".repeat(64)}`,
    artifactManifestDigest: `sha256:${"e".repeat(64)}`,
    stage: "child-validate",
    approval: { maxCostUsd: 1, maxDurationMs: 600_000, maxRetries: 0 },
    events: [] as Record<string, unknown>[],
    durationMs: 100,
    child,
  };
}

async function withChildFixture(run: (context: ReturnType<typeof childFixture>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-provider-child-test-"));
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("coremind-provider-child-test-")
  ) {
    throw new Error("测试清理路径越界");
  }
  try {
    const context = childFixture(path.join(directory, "marker.txt"));
    await writeFile(context.markerFile, context.marker, "utf8");
    await run(context);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function childFixture(markerFile = "unused") {
  return {
    markerFile,
    marker: "synthetic-marker",
    markerStatus: "not_checked",
    approvalsAllowed: 2,
    approvalsDenied: 0,
    events: [
      { type: "provider_request", agent: "parent" },
      { type: "provider_request", agent: "worker" },
      { type: "tool_call", agent: "parent", tool: "delegate" },
      { type: "tool_result", agent: "parent", tool: "delegate", isError: false },
      { type: "tool_call", agent: "worker", tool: "write" },
      { type: "tool_result", agent: "worker", tool: "write", isError: false },
    ],
    result: {
      outcome: { status: "succeeded" },
      childRuns: {
        nodes: [{ status: "joined", outcome: { status: "succeeded" }, result: { done: true } }],
        activeDescendants: 0,
        quiescent: true,
      },
    },
  };
}

describe("Provider 认证批准边界", () => {
  it("父模型消耗时间和费用后仍能划拨认证 Child，且不扩大批准上限", () => {
    const budget = new RunBudgetController(
      resolveRuntimeLimits({ runTimeoutMs: 120_000, maxCostUsd: 1, maxTokens: 80_000 }, {}),
      () => {},
    );
    budget.restore({ type: "turn_end", agent: "parent", costUsd: 0.1, tokens: 100 });
    const other = { tokens: 30_000, toolCalls: 1, steps: 4 };
    expect(() => budget.reserveChild({ ...other, wallTimeMs: 120_000, costUsd: 1 }, 1_000)).toThrow(
      "wallTimeMs",
    );
    expect(() => budget.reserveChild({ ...other, wallTimeMs: 60_000, costUsd: 1 }, 1_000)).toThrow(
      "costUsd",
    );
    const child = certificationChildBudget({ wallTimeMs: 120_000, costUsd: 1 });
    expect(() => budget.reserveChild({ ...other, ...child }, 1_000)).not.toThrow();
    expect(child.wallTimeMs).toBeLessThanOrEqual(120_000 - 1_000);
    expect(child.costUsd).toBeLessThanOrEqual(1 - 0.1);
  });
  it("五项批准不完整或候选身份不一致时在联网前失败", () => {
    const approved = {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: "0.5",
      maxDurationMinutes: "15",
      expectedVersion: "0.7.0",
      expectedCommit: "a".repeat(40),
      expectedRuntimeArtifactSha256: "b".repeat(64),
    };
    const actual = {
      version: "0.7.0",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
    };

    for (const key of ["provider", "model", "credentialEnv", "maxCostUsd", "maxDurationMinutes"]) {
      expect(() => validateCertificationApproval({ ...approved, [key]: "" }, actual)).toThrow(
        `认证批准边界不完整：${key}`,
      );
    }
    expect(() =>
      validateCertificationApproval({ ...approved, expectedCommit: "c".repeat(40) }, actual),
    ).toThrow("认证候选提交与批准值不一致");
    expect(validateCertificationApproval(approved, actual)).toMatchObject({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: 0.5,
      maxDurationMs: 900_000,
      maxRetries: 0,
    });
  });

  it("候选清单必须绑定批准提交、版本与 Runtime 包摘要", () => {
    const artifact = Buffer.from("candidate runtime artifact", "utf8");
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const raw = `${JSON.stringify({
      schemaVersion: 1,
      version: "0.7.0",
      commit: "a".repeat(40),
      artifacts: [
        {
          kind: "npm",
          name: "coremind-runtime",
          version: "0.7.0",
          path: "coremind-runtime-0.7.0.tgz",
          sha256: artifactSha256,
        },
      ],
    })}\n`;

    expect(
      inspectCandidateManifest(raw, {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: artifactSha256,
      }),
    ).toMatchObject({
      candidateArtifactPath: "coremind-runtime-0.7.0.tgz",
      candidateArtifactSha256: artifactSha256,
      artifactManifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(() => verifyCandidateArtifact(artifact, artifactSha256)).not.toThrow();
    expect(() => verifyCandidateArtifact(Buffer.from("replaced"), artifactSha256)).toThrow(
      "候选 Runtime Artifact 实际摘要与清单不一致",
    );
    expect(() =>
      inspectCandidateManifest(raw, {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "c".repeat(64),
      }),
    ).toThrow("候选 Runtime Artifact 与批准值不一致");
    expect(() =>
      inspectCandidateManifest(raw.replace("coremind-runtime-0.7.0.tgz", "../runtime.tgz"), {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: artifactSha256,
      }),
    ).toThrow("候选 Runtime Artifact 路径无效");
  });
});

describe("Provider 认证诊断", () => {
  it("父级处置错误保留 Child 根因并对整条诊断脱敏", () => {
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: { status: "paused", finishReason: "delegation_disposition_required" },
          childRuns: {
            nodes: [
              {
                agentName: "worker",
                outcome: {
                  status: "paused",
                  finishReason: "context_capability_conflict",
                  error: { message: "maxTokens 30000 超过模型输出上限 4096 sk-secret" },
                },
              },
            ],
          },
        },
        "父子场景",
        ["sk-secret"],
      ),
    ).toThrow(
      "Child worker: context_capability_conflict / maxTokens 30000 超过模型输出上限 4096 [REDACTED]",
    );
  });
  it("失败时保留终态、错误码和上游诊断", () => {
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: {
            status: "failed",
            finishReason: "agent_failed",
            error: { code: "agent_failed", message: "403 AccessDenied.Unpurchased" },
          },
        },
        "流式场景",
      ),
    ).toThrow("流式场景失败：agent_failed / agent_failed / 403 AccessDenied.Unpurchased");
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: {
            status: "failed",
            finishReason: "agent_failed",
            error: { code: "agent_failed", message: "upstream leaked sk-cert-secret" },
          },
        },
        "父子场景",
        ["sk-cert-secret"],
      ),
    ).toThrow("父子场景失败：agent_failed / agent_failed / upstream leaked [REDACTED]");
  });

  it("只为包含版本且三轮会话通过的完整结果生成证据", () => {
    const evidence = createCertificationEvidence({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.2.0-rc.1",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-09T20:00:00.000Z",
      platform: "win32-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      version: "0.2.0-rc.1",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      details: { multiTurn: { passed: true, turns: 3 } },
      checks: expect.arrayContaining(["abort", "long-context", "cancel-convergence"]),
      secretsRecorded: false,
    });
  });

  it("拒绝缺少版本或不足三轮的认证证据", () => {
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "",
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(3),
      }),
    ).toThrow("缺少 CoreMind 版本");
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "0.2.0-rc.1",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(2),
      }),
    ).toThrow("至少需要三轮");
  });

  it("拒绝缺少完整父子产品链或取消收敛的证据", () => {
    const details = completeDetails(3);
    delete details.childRunCancel;

    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        testedAt: "2026-08-31T20:00:00.000Z",
        platform: "linux-x64",
        node: "v22.22.1",
        details,
        ...completeBoundEvidence(),
      }),
    ).toThrow("Provider 认证检查未通过：childRunCancel");
  });

  it("拒绝缺少候选制品、零重试用量或超出人工费用上限的证据", () => {
    const input = {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.7.0",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-31T20:00:00.000Z",
      platform: "linux-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    };

    expect(() => createCertificationEvidence({ ...input, candidateArtifactSha256: "" })).toThrow(
      "缺少候选 Runtime Artifact SHA-256",
    );
    expect(() =>
      createCertificationEvidence({ ...input, usage: { ...input.usage, retries: 1 } }),
    ).toThrow("Provider 认证禁止自动重试");
    expect(() =>
      createCertificationEvidence({ ...input, usage: { ...input.usage, costUsd: 0.6 } }),
    ).toThrow("Provider 认证用量超过批准边界");

    expect(createCertificationEvidence(input)).toMatchObject({
      checkId: "P0-20",
      evidenceLevel: "live-provider",
      runtimeDigest: `sha256:${"d".repeat(64)}`,
      artifactManifestDigest: `sha256:${"e".repeat(64)}`,
      candidateArtifactSha256: "f".repeat(64),
      approval: { maxRetries: 0 },
      usage: { providerCalls: 10, retries: 0 },
    });
  });
});

describe("Provider 认证台账", () => {
  it("按 Provider 与版本替换记录，并保存提交与 Runtime 摘要", () => {
    const evidence = createCertificationEvidence({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.3.0-rc.2",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-12T18:00:00.000Z",
      platform: "win32-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    });
    const ledger = upsertCertificationRecord(
      {
        schemaVersion: 2,
        updatedAt: "2026-08-11",
        criteria: evidence.checks,
        certifications: [{ id: "alibaba-model-studio", version: "0.3.0-rc.2", evidence: "old" }],
      },
      evidence,
      "https://example.test/evidence.json",
    );

    expect(ledger.updatedAt).toBe("2026-08-12");
    expect(ledger.certifications).toHaveLength(1);
    expect(ledger.certifications[0]).toMatchObject({
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      evidence: "https://example.test/evidence.json",
    });
  });
});

function completeBoundEvidence() {
  return {
    candidateArtifactSha256: "f".repeat(64),
    runtimeDigest: `sha256:${"d".repeat(64)}`,
    artifactManifestDigest: `sha256:${"e".repeat(64)}`,
    ref: "https://github.com/Eclipseic1848/CoreMind/actions/runs/1",
    approval: {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: 0.5,
      maxDurationMs: 900_000,
      maxRetries: 0,
    },
    usage: {
      providerCalls: 10,
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1_000,
      costUsd: 0.1,
      durationMs: 120_000,
      retries: 0,
    },
  };
}

function completeDetails(turns: number) {
  return {
    streaming: { passed: true },
    toolCall: { passed: true },
    structuredResult: { passed: true },
    multiTurn: { passed: true, turns },
    abort: { passed: true },
    error: { passed: true },
    longContext: { passed: true },
    childRun: {
      passed: true,
      parentProviderCalls: 2,
      delegationToolCalled: true,
      childProviderCalls: 2,
      childTool: "write",
      childToolCompleted: true,
      childOutcome: "succeeded",
      joined: true,
      quiescent: true,
      structuredResultSha256: "c".repeat(64),
    },
    childRunCancel: {
      passed: true,
      abortTriggeredAt: "child_text_delta",
      parentOutcome: "paused",
      childOutcome: "aborted",
      activeDescendants: 0,
      executionConverged: true,
      convergenceMs: 120,
      maxConvergenceMs: 5_000,
    },
  };
}
