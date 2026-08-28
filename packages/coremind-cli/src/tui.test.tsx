import type { ChatSession, ChildRunNodeProjection, RunResult } from "coremind-ai";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval.js";
import { ChatTUI, formatChildRuns, formatRunStatus } from "./tui.js";

function createSession(): ChatSession {
  return {
    onEvent: () => () => {},
    abort: vi.fn(),
    listCheckpoints: () => [],
    diffCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    chat: vi.fn(),
  } as unknown as ChatSession;
}

function childNode(overrides: Partial<ChildRunNodeProjection> = {}): ChildRunNodeProjection {
  return {
    parentRunId: "run-parent",
    delegationId: "delegation-child",
    childRunId: "run-child",
    agentName: "researcher",
    inputFingerprint: "input-child",
    budget: {
      tokens: 800,
      toolCalls: 2,
      costUsd: 0.2,
      wallTimeMs: 4000,
      steps: 3,
      descendants: 0,
    },
    permissions: {
      mode: "ask",
      workspaceOnly: true,
      network: "deny",
      tools: [],
      paths: [],
      credentials: [],
    },
    model: { providerId: "mock", model: "research-model" },
    workspace: { canonicalRoot: "C:/workspace", lease: "shared_canonical" },
    status: "running",
    ...overrides,
  };
}

describe("Windows TUI 交互验收", () => {
  it("展开 Child Run tree 显示层级、预算、结果、Recovery 与未决风险", () => {
    expect(
      formatChildRuns({
        childRuns: {
          nodes: [
            childNode({
              delegationId: "delegation-review",
              childRunId: "run-child-review",
              agentName: "reviewer-with-a-very-long-target-name",
              budget: {
                tokens: 1200,
                toolCalls: 3,
                costUsd: 0.5,
                wallTimeMs: 5000,
                steps: 4,
                descendants: 1,
              },
              status: "joined",
              outcome: { status: "succeeded", finishReason: "reviewed" },
              result: {
                outcome: { status: "succeeded", finishReason: "reviewed" },
                evidence: ["report.md"],
                artifacts: ["artifact-review"],
                workspaceChanges: [],
                unresolvedRisks: ["需要人工核对引用"],
              },
              recovery: { resumable: false, requiresHuman: false },
            }),
            childNode({
              parentRunId: "run-child-review",
              delegationId: "delegation-citation",
              childRunId: "run-child-citation",
              agentName: "citation-checker",
              budget: {
                tokens: 400,
                toolCalls: 1,
                costUsd: 0.1,
                wallTimeMs: 2000,
                steps: 2,
                descendants: 0,
              },
              status: "paused",
              outcome: { status: "paused", finishReason: "human_required" },
              result: {
                outcome: { status: "paused", finishReason: "human_required" },
                evidence: [],
                artifacts: [],
                workspaceChanges: [],
                unresolvedRisks: ["引用来源不明确"],
              },
              recovery: { resumable: true, requiresHuman: true },
            }),
          ],
          activeDescendants: 0,
          unhandledDescendants: 1,
          quiescent: true,
        },
      } as RunResult),
    ).toBe(
      [
        "Child Runs 2 · 活动 0 · 未处置 1 · 已静止",
        "└─ 目标 reviewer-with-a-very-long-target-name · joined · succeeded/reviewed",
        "   身份 run-parent → run-child-review · delegation-review",
        "   预算 1200 tokens · 工具 3 · $0.5 · 5000ms · 步骤 4 · 后代 1",
        "   Recovery 不可恢复 · 无需人工 · 未决风险 1",
        "   风险：需要人工核对引用",
        "   └─ 目标 citation-checker · paused · paused/human_required",
        "      身份 run-child-review → run-child-citation · delegation-citation",
        "      预算 400 tokens · 工具 1 · $0.1 · 2000ms · 步骤 2 · 后代 0",
        "      Recovery 可恢复 · 需要人工 · 未决风险 1",
        "      风险：引用来源不明确",
      ].join("\n"),
    );
  });

  it("默认运行摘要突出 Child Run 活动数与未处置风险", () => {
    const run = createRun({
      childRuns: {
        nodes: [{} as never, {} as never],
        activeDescendants: 1,
        unhandledDescendants: 1,
        quiescent: false,
      },
    });

    expect(formatRunStatus(run)).toContain("Child Runs 2 · 活动 1 · 未处置 1");
  });

  it("通过 /children 从简洁摘要展开统一 Projection 的 Child Run 详情", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({
      text: "完成",
      events: [],
      run: createRun({
        childRuns: {
          nodes: [
            childNode({
              status: "paused",
              outcome: { status: "paused", finishReason: "human_required" },
              result: {
                outcome: { status: "paused", finishReason: "human_required" },
                evidence: [],
                artifacts: [],
                workspaceChanges: [],
                unresolvedRisks: ["需要确认来源"],
              },
              recovery: { resumable: true, requiresHuman: true },
            }),
          ],
          activeDescendants: 0,
          unhandledDescendants: 1,
          quiescent: true,
        },
      }),
    });
    const app = render(
      <ChatTUI
        title="Child Run tree"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "执行委派");
    await settle();
    expect(app.lastFrame()).toContain("Child Runs 1 · 活动 0 · 未处置 1");
    expect(app.lastFrame()).not.toContain("身份 run-parent → run-child");

    await typeCommand(app.stdin.write, "/children");
    await settle();
    expect(app.lastFrame()).toContain("目标 researcher · paused · paused/human_required");
    expect(app.lastFrame()).toContain("身份 run-parent → run-child · delegation-child");
    expect(app.lastFrame()).toContain("风险：需要确认来源");
    app.unmount();
  });

  it("运行中可从 canonical Projection 展开当前 Child Run tree", async () => {
    const session = createSession();
    const inspectCurrentRunProjection = vi.fn().mockResolvedValue({
      childRuns: {
        nodes: [childNode()],
        activeDescendants: 1,
        unhandledDescendants: 1,
        quiescent: false,
      },
    });
    Object.assign(session, { inspectCurrentRunProjection });
    vi.mocked(session.chat).mockImplementation(() => new Promise(() => {}));
    const app = render(
      <ChatTUI
        title="运行中 Child Run"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "执行委派");
    await settle();
    await typeCommand(app.stdin.write, "/children");
    await settle();

    expect(inspectCurrentRunProjection).toHaveBeenCalledOnce();
    expect(app.lastFrame()).toContain("Child Runs 1 · 活动 1 · 未处置 1 · 未静止");
    expect(app.lastFrame()).toContain("目标 researcher · running · 等待结果");
    app.unmount();
  });

  it("当前 Projection 尚无 Recovery 决策时不伪装成不可恢复", () => {
    expect(
      formatChildRuns({
        childRuns: {
          nodes: [childNode()],
          activeDescendants: 1,
          unhandledDescendants: 1,
          quiescent: false,
        },
      } as RunResult),
    ).toContain("Recovery 等待投影 · 未决风险 0");
  });

  it("渲染标题、输入框和帮助命令，并能正常退出", async () => {
    const onExit = vi.fn();
    const app = render(
      <ChatTUI
        title="RC 验收"
        session={createSession()}
        approvals={new ApprovalQueue(true)}
        onExit={onExit}
      />,
    );

    expect(app.lastFrame()).toContain("CoreMind · RC 验收");
    expect(app.lastFrame()).toContain("你 >");
    await typeCommand(app.stdin.write, "/help");
    await settle();
    expect(app.lastFrame()).toContain("/checkpoints");
    await typeCommand(app.stdin.write, "/exit");
    await settle();
    expect(onExit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("显示真实审批面板并接受键盘批准", async () => {
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI
        title="审批验收"
        session={createSession()}
        approvals={approvals}
        onExit={() => {}}
      />,
    );
    const decision = approvals.request({
      approvalId: "approval-1",
      runId: "run-1",
      agent: "assistant",
      tool: "write",
      args: { path: "result.txt" },
      risk: "high",
      reason: "验证高风险写入操作必须由用户批准",
      effect: {
        operations: ["write"],
        paths: ["result.txt"],
        urls: [],
        reversible: true,
        declared: true,
      },
    });
    await settle();
    expect(app.lastFrame()).toContain("权限审批：write（high）");
    app.stdin.write("y");
    await expect(decision).resolves.toBe("allow");
    app.unmount();
  });

  it("Child Run 委派审批优先显示目标、任务摘要与收紧预算", async () => {
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI
        title="委派审批"
        session={createSession()}
        approvals={approvals}
        onExit={() => {}}
      />,
    );
    const decision = approvals.request({
      approvalId: "approval-delegation",
      runId: "run-parent",
      agent: "main",
      tool: "delegate",
      args: {
        target: "researcher",
        task: `核验资料并返回证据${"很长的任务正文".repeat(80)}`,
        references: ["fact:requirements"],
        limits: { tokens: 1000, toolCalls: 2, wallTimeMs: 5000, steps: 3 },
      },
      risk: "high",
      reason: "创建受限 Child Run",
      effect: { operations: ["read"], paths: [], urls: [], reversible: true, declared: true },
    });

    await settle();
    expect(app.lastFrame()).toContain("Child Run 委派审批：researcher");
    expect(app.lastFrame()).toContain("预算：1000 tokens · 工具 2 · 5000ms · 步骤 3");
    expect(app.lastFrame()).toContain("任务：核验资料并返回证据");
    expect(app.lastFrame()).not.toContain("很长的任务正文很长的任务正文很长的任务正文");
    app.stdin.write("y");
    await expect(decision).resolves.toBe("allow");
    app.unmount();
  });

  it("长参数不会遮住审批目标与副作用", async () => {
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI
        title="长参数审批"
        session={createSession()}
        approvals={approvals}
        onExit={() => {}}
      />,
    );
    const decision = approvals.request({
      approvalId: "approval-long",
      runId: "run-long",
      agent: "assistant",
      tool: "write",
      args: { content: "很长的正文".repeat(100), path: "reports/final-acceptance.md" },
      risk: "low",
      reason: "写入验收报告",
      effect: {
        operations: ["write"],
        paths: ["reports/final-acceptance.md"],
        urls: [],
        reversible: true,
        declared: true,
      },
    });

    await settle();
    expect(app.lastFrame()).toContain("目标：reports/final-acceptance.md");
    expect(app.lastFrame()).toContain("副作用：write · 可回退");
    expect(app.lastFrame()).not.toContain("很长的正文很长的正文很长的正文");
    app.stdin.write("n");
    await expect(decision).resolves.toBe("deny");
    app.unmount();
  });

  it("长流式输出持续渲染到末尾标记", async () => {
    let listener: Parameters<ChatSession["onEvent"]>[0] | undefined;
    const session = createSession();
    session.onEvent = (handler) => {
      listener = handler;
      return () => {};
    };
    const app = render(
      <ChatTUI
        title="长输出验收"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    listener?.({ type: "agent_start", agent: "assistant" });
    listener?.({ type: "text_delta", agent: "assistant", delta: "长输出内容".repeat(1_000) });
    listener?.({ type: "text_delta", agent: "assistant", delta: "<END>" });
    await settle();

    expect(app.lastFrame()).toContain("<END>");
    app.unmount();
  });

  it("忙碌生成期间输入 /abort 会中止当前回答", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockImplementation(() => new Promise(() => {}));
    const app = render(
      <ChatTUI
        title="中止验收"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "生成长回答");
    await settle();
    expect(session.chat).toHaveBeenCalledOnce();

    await typeCommand(app.stdin.write, "/abort");
    await settle();
    expect(session.abort).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("忙碌期间显示 Loop 的当前验证与修复进度", async () => {
    let listener: Parameters<ChatSession["onEvent"]>[0] | undefined;
    const session = createSession();
    session.onEvent = (handler) => {
      listener = handler;
      return () => {};
    };
    vi.mocked(session.chat).mockImplementation(() => new Promise(() => {}));
    const app = render(
      <ChatTUI
        title="Loop 进度"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "修复缺陷");
    listener?.({
      type: "loop_state",
      from: "verifying",
      to: "repairing",
      trigger: "VERIFIED",
      iteration: 2,
      repairs: 1,
    });
    await settle();

    expect(app.lastFrame()).toContain("修复中 · 第 2 轮 · 已修复 1 次");
    app.unmount();
  });

  it("Runtime 返回失败终态时显示可读诊断，而不是静默结束", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({
      text: "",
      events: [],
      run: createRun({
        outcome: {
          status: "failed",
          finishReason: "agent_failed",
          error: { code: "agent_failed", message: "模型连接失败" },
        },
        operation: failedOperation(),
        releaseReadiness: { ready: false, blockers: ["运行失败"], warnings: [] },
      }),
    });
    const app = render(
      <ChatTUI
        title="失败终态"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "执行任务");
    await settle();

    expect(app.lastFrame()).toContain("运行失败：模型连接失败");
    app.unmount();
  });

  it("显示 Artifact、上下文压缩、恢复和评测状态", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({
      text: "完成",
      events: [],
      run: createRun({
        metrics: {
          durationMs: 1,
          turns: 2,
          steps: { total: 1, succeeded: 1, failed: 0 },
          toolCalls: 1,
          toolFailures: 0,
          retries: 0,
          tokens: 42,
          outputChars: 2,
          context: {
            inputTokens: 20,
            outputTokens: 22,
            cacheReadTokens: 5,
            cacheWriteTokens: 3,
            promptCacheStatus: "available",
            compactions: 1,
            stablePrefixFingerprints: ["prefix-1"],
          },
          artifacts: { stored: 1, blocked: 0, totalBytes: 128 },
        },
        artifacts: [
          {
            artifactId: "artifact-1",
            status: "stored",
            relativePath: ".coremind/artifacts/artifact-1.log",
            sizeBytes: 128,
            sha256: "a".repeat(64),
            mediaType: "text/plain",
            createdAt: "2026-08-11T00:00:00.000Z",
            retention: "run",
            redaction: "none",
          },
        ],
      }),
    });
    const app = render(
      <ChatTUI
        title="状态面板"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "执行");
    await settle();
    await typeCommand(app.stdin.write, "/status");
    await settle();
    expect(app.lastFrame()).toContain("artifact 1/0");
    expect(app.lastFrame()).toContain("压缩 1");
    expect(app.lastFrame()).toContain("不可恢复");

    await typeCommand(app.stdin.write, "/artifacts");
    await settle();
    expect(app.lastFrame()).toContain("artifact-1 · stored · 128 bytes");

    await typeCommand(app.stdin.write, "/context");
    await settle();
    expect(app.lastFrame()).toContain("cache available");
    expect(app.lastFrame()).toContain("稳定前缀 1");

    await typeCommand(app.stdin.write, "/observability");
    await settle();
    expect(app.lastFrame()).toContain("本地观测 开启");
    expect(app.lastFrame()).toContain("Telemetry DISABLED");
    app.unmount();
  });
});

function createRun(overrides: Partial<Omit<RunResult, "snapshot">> = {}): RunResult {
  const base: Omit<RunResult, "snapshot"> = {
    runId: "run-test",
    operation: {
      schemaVersion: 1,
      operationId: "operation-test",
      runId: "run-test",
      correlationId: "run-test:operation-test",
      state: "completed",
      transitionSequence: 3,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
    },
    outcome: { status: "succeeded", finishReason: "completed" },
    metrics: {
      durationMs: 1,
      turns: 1,
      steps: { total: 0, succeeded: 0, failed: 0 },
      toolCalls: 0,
      toolFailures: 0,
      retries: 0,
      outputChars: 2,
    },
    evaluation: {
      profile: "standard",
      scenarioResults: [],
      qualityScores: {},
      securityFindings: [],
    },
    releaseReadiness: { ready: false, blockers: ["尚未执行场景评测"], warnings: [] },
    trace: [],
    checkpoints: [],
    outputs: new Map(),
    messages: new Map(),
    transcript: "完成",
    artifacts: [],
    extensions: [],
    observability: {
      schemaVersion: 1,
      localEnabled: true,
      derivedFromSequence: 1,
      run: { status: "finished", resumable: false },
      turns: { started: 1, completed: 1, active: 0 },
      calls: { started: 0, completed: 0, failed: 0, active: 0, durationMs: 0 },
      tools: [],
      errors: [],
      context: { budgets: 0, compactions: 0, failures: 0 },
      artifacts: { stored: 0, blocked: 0 },
      sharedState: { pendingControls: 0 },
      recovery: { resumable: false },
      telemetry: {
        mode: "DISABLED",
        source: "default",
        exporterLoaded: false,
        contentLevel: "metrics_only",
        allowedFields: [],
        queued: 0,
        handedOff: 0,
        failed: 0,
        dropped: 0,
        duplicates: 0,
        shutdownTimedOut: false,
        deliverySemantics: "best_effort_handoff_not_delivery",
        authorizedScopes: [],
      },
    },
  };
  const result = { ...base, ...overrides };
  return {
    ...result,
    snapshot: {
      schemaVersion: 1,
      runId: result.runId,
      operation: result.operation,
      outcome: result.outcome,
      metrics: result.metrics,
      evaluation: result.evaluation,
      releaseReadiness: result.releaseReadiness,
      trace: result.trace,
      checkpoints: result.checkpoints,
      artifacts: result.artifacts ?? [],
      extensions: result.extensions ?? [],
      resumable: result.operation.state === "paused" && result.outcome.status === "paused",
    },
  };
}

function failedOperation(): RunResult["operation"] {
  return {
    schemaVersion: 1,
    operationId: "operation-failed",
    runId: "run-test",
    correlationId: "run-test:operation-failed",
    state: "failed",
    transitionSequence: 3,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    failureReason: "agent_failed",
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function typeCommand(write: (value: string) => void, command: string): Promise<void> {
  for (const character of command) {
    write(character);
    await settle();
  }
  write("\r");
}
