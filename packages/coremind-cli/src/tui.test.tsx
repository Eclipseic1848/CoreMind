import type { ChatSession, ChildRunNodeProjection, ControlReceipt, RunResult } from "coremind-ai";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { controlInputId } from "../../coremind-runtime/src/input-receipt.js";
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
    steer: vi.fn().mockResolvedValue(controlReceipt("applied")),
    followUp: vi.fn().mockResolvedValue(controlReceipt("applied")),
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
    model: {
      providerId: "mock",
      model: "research-model",
      providerConfigFingerprint: `sha256:${"a".repeat(64)}`,
      agentPromptFingerprint: `sha256:${"b".repeat(64)}`,
      agentDelegationFingerprint: `sha256:${"c".repeat(64)}`,
    },
    workspace: { canonicalRoot: "C:/workspace", lease: "shared_canonical" },
    status: "running",
    ...overrides,
  };
}

describe("Windows TUI 交互验收", () => {
  it("合并中文末字和回车仅发送一次完整输入", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({ text: "完成", events: [], run: createRun() });
    const app = render(
      <ChatTUI
        title="合并输入"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );
    try {
      app.stdin.write("中文末字\r");
      await settle();
      expect(session.chat).toHaveBeenCalledExactlyOnceWith("中文末字");
    } finally {
      app.unmount();
    }
  });

  it("忙碌时单次合并退出会中止运行，等待真实收尾后只退出一次", async () => {
    const session = createSession();
    let finish!: () => void;
    vi.mocked(session.chat).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: "完成", events: [], run: createRun() });
        }),
    );
    const onExit = vi.fn();
    const app = render(
      <ChatTUI
        title="忙碌退出"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={onExit}
      />,
    );
    try {
      app.stdin.write("开始运行\r");
      await settle();
      expect(session.chat).toHaveBeenCalledExactlyOnceWith("开始运行");
      app.stdin.write("/exit\r");
      await settle();
      expect(session.abort).toHaveBeenCalledOnce();
      expect(onExit).not.toHaveBeenCalled();
      finish();
      await settle();
      expect(onExit).toHaveBeenCalledOnce();
      expect(session.chat).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await settle();
      app.unmount();
    }
  });

  it("审批期间退出拒绝当前工具，收尾前重复输入不会再次退出或发起运行", async () => {
    const session = createSession();
    const approvals = new ApprovalQueue(true);
    let finish!: () => void;
    vi.mocked(session.chat).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: "已取消", events: [], run: createRun() });
        }),
    );
    const onExit = vi.fn();
    const app = render(
      <ChatTUI title="审批退出" session={session} approvals={approvals} onExit={onExit} />,
    );
    try {
      app.stdin.write("开始运行\r");
      await settle();
      const decision = approvals.request(controlApproval());
      await settle();
      app.stdin.write("/exit\r");
      await expect(decision).resolves.toBe("deny");
      expect(session.abort).toHaveBeenCalledOnce();
      expect(onExit).not.toHaveBeenCalled();
      app.stdin.write("/exit\r");
      app.stdin.write("新任务\r");
      await settle();
      expect(session.chat).toHaveBeenCalledTimes(1);
      finish();
      await settle();
      expect(onExit).toHaveBeenCalledOnce();
      expect(session.abort).toHaveBeenCalledOnce();
    } finally {
      approvals.close();
      finish?.();
      await settle();
      app.unmount();
    }
  });

  it("bracketed 多行粘贴保留完整草稿，只由后续独立 Enter 发送", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({ text: "完成", events: [], run: createRun() });
    const app = render(
      <ChatTUI
        title="粘贴"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );
    try {
      app.stdin.write("\x1b[200~中文👩‍🔬\ny\x1b[201~");
      await settle();
      expect(session.chat).not.toHaveBeenCalled();
      app.stdin.write("\r");
      await settle();
      expect(session.chat).toHaveBeenCalledExactlyOnceWith("中文👩‍🔬\ny");
    } finally {
      app.unmount();
    }
  });

  it("审批中合并控制命令回车能提交，粘贴 y 不会批准当前工具", async () => {
    const session = createSession();
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI title="审批输入隔离" session={session} approvals={approvals} onExit={() => {}} />,
    );
    const resolved = vi.fn();
    const decision = approvals
      .request({
        approvalId: "coalesced-approval",
        runId: "run-test",
        agent: "main",
        tool: "write",
        args: { path: "note.txt" },
        argumentsFingerprint: "a".repeat(64),
        risk: "high",
        reason: "合成审批",
        effect: {
          operations: ["write"],
          paths: ["note.txt"],
          urls: [],
          reversible: true,
          declared: true,
        },
      })
      .then(resolved);
    try {
      await settle();
      app.stdin.write("/steer 追加中文\r");
      await settle();
      expect(session.steer).toHaveBeenCalledExactlyOnceWith("追加中文");
      expect(resolved).not.toHaveBeenCalled();
      app.stdin.write("\x1b[200~y\r\x1b[201~");
      await settle();
      expect(resolved).not.toHaveBeenCalled();
      expect(approvals.current?.request.approvalId).toBe("coalesced-approval");
    } finally {
      approvals.close();
      await decision;
      app.unmount();
    }
  });

  it("退格删除完整 emoji 字符簇，不向模型发送残缺代理或连接符", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockResolvedValue({ text: "完成", events: [], run: createRun() });
    const app = render(
      <ChatTUI
        title="字符簇"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );
    try {
      app.stdin.write("保留👩‍🔬");
      await settle();
      app.stdin.write("\x7f");
      await settle();
      app.stdin.write("\r");
      await settle();
      expect(session.chat).toHaveBeenCalledExactlyOnceWith("保留");
    } finally {
      app.unmount();
    }
  });
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
      argumentsFingerprint: "a".repeat(64),
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
      argumentsFingerprint: "b".repeat(64),
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
      argumentsFingerprint: "c".repeat(64),
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

  it("工具行随事件更新并按 callId 对齐乱序结果", async () => {
    let listener: Parameters<ChatSession["onEvent"]>[0] | undefined;
    const session = createSession();
    session.onEvent = (handler) => {
      listener = handler;
      return () => {};
    };
    const app = render(
      <ChatTUI
        title="工具状态"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );
    try {
      await settle();
      listener?.({ type: "agent_start", agent: "assistant" });
      await settle();
      for (const callId of ["first", "second"]) {
        listener?.({ type: "tool_call", agent: "assistant", tool: "read", args: {}, callId });
        await settle();
      }
      const rows = () =>
        (app.lastFrame() ?? "")
          .split("⚙ read ·")
          .slice(1)
          .map((row) => row.replace(/\s+/gu, " "));
      expect(rows()).toHaveLength(2);
      expect(rows().find((row) => row.includes("Call first"))).toContain("已登记，等待准入");
      expect(rows().find((row) => row.includes("Call second"))).toContain("已登记，等待准入");
      listener?.({
        type: "tool_result",
        agent: "assistant",
        tool: "read",
        callId: "unknown",
        isError: true,
      });
      await settle();
      expect(rows().find((row) => row.includes("Call first"))).toContain("已登记，等待准入");
      expect(rows().find((row) => row.includes("Call second"))).toContain("已登记，等待准入");
      expect(rows().find((row) => row.includes("Call unknown"))).toContain("原始调用不在当前窗口");
      listener?.({
        type: "tool_result",
        agent: "assistant",
        tool: "read",
        callId: "second",
        isError: true,
      });
      await settle();
      expect(rows().find((row) => row.includes("Call first"))).toContain("已登记，等待准入");
      expect(rows().find((row) => row.includes("Call second"))).toContain("执行失败");
      listener?.({
        type: "tool_result",
        agent: "assistant",
        tool: "read",
        callId: "first",
        isError: false,
      });
      await settle();
      expect(rows().find((row) => row.includes("Call first"))).toContain("结果已返回");
      expect(rows().find((row) => row.includes("Call second"))).toContain("执行失败");
    } finally {
      app.unmount();
    }
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
    await typeCommand(app.stdin.write, "下一轮");
    await settle();
    expect(session.chat).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("忙碌生成期间保留尚未发送的普通输入", async () => {
    const session = createSession();
    vi.mocked(session.chat).mockImplementation(() => new Promise(() => {}));
    const app = render(
      <ChatTUI
        title="输入保留验收"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );

    await typeCommand(app.stdin.write, "生成长回答");
    await typeCommand(app.stdin.write, "下一条消息");
    await settle();

    expect(session.chat).toHaveBeenCalledOnce();
    expect(app.lastFrame()).toContain("下一条消息");
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
    expect(app.lastFrame()).toMatch(/artifact\s+1\/0/u);
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

describe("运行中控制与普通草稿", () => {
  it.each(["steer", "follow-up"])(
    "审批期间的 /%s 不消费 y/n，迟到回执保留新草稿",
    async (command) => {
      const session = createSession();
      const approvals = new ApprovalQueue(true);
      const turn = { text: "完成", events: [], run: createRun() };
      let finishChat!: (value: typeof turn) => void;
      let finishControl!: (value: ControlReceipt) => void;
      let rejectControl!: (error: Error) => void;
      const firstChat = new Promise<typeof turn>((resolve) => {
        finishChat = resolve;
      });
      const response = new Promise<ControlReceipt>((resolve, reject) => {
        finishControl = resolve;
        rejectControl = reject;
      });
      vi.mocked(session.chat).mockReturnValueOnce(firstChat).mockResolvedValue(turn);
      vi.mocked(command === "steer" ? session.steer : session.followUp).mockReturnValue(response);
      const app = render(
        <ChatTUI title="控制草稿" session={session} approvals={approvals} onExit={() => {}} />,
      );
      try {
        await typeCommand(app.stdin.write, "开始");
        await typeCommand(app.stdin.write, "原普通草稿");
        const decision = approvals.request(controlApproval());
        await settle();
        await typeCommand(app.stdin.write, `/${command} y n 仍需批准`);
        await vi.waitFor(() =>
          expect(command === "steer" ? session.steer : session.followUp).toHaveBeenCalledWith(
            "y n 仍需批准",
          ),
        );
        expect(approvals.current?.request.approvalId).toBe("control-approval");
        expect(app.lastFrame()).toContain("原普通草稿");
        app.stdin.write("n");
        await expect(decision).resolves.toBe("deny");
        await settle();
        await typeCommand(app.stdin.write, "新草稿");
        if (command === "follow-up") rejectControl(new Error("control_unavailable"));
        else finishControl(controlReceipt("applied"));
        await vi.waitFor(() =>
          expect(app.lastFrame()).toContain(
            command === "follow-up"
              ? "命令失败：control_unavailable"
              : "控制 control-original · Run run-original · applied",
          ),
        );
        expect(app.lastFrame()).toContain("原普通草稿新草稿");
        expect(session.chat).toHaveBeenCalledOnce();
        finishChat(turn);
        await vi.waitFor(() => expect(app.lastFrame()).toContain("succeeded"));
        app.stdin.write("\r");
        await vi.waitFor(() => expect(session.chat).toHaveBeenNthCalledWith(2, "原普通草稿新草稿"));
      } finally {
        finishControl(controlReceipt("applied"));
        finishChat(turn);
        approvals.close();
        app.unmount();
      }
    },
  );

  it("审批命令模式 Esc 返回原审批，空控制命令不批准或拒绝", async () => {
    const session = createSession();
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI title="审批命令" session={session} approvals={approvals} onExit={() => {}} />,
    );
    try {
      app.stdin.write("保留草稿");
      await settle();
      const decision = approvals.request(controlApproval());
      await settle();
      await typeCommand(app.stdin.write, "/steer");
      await settle();
      expect(app.lastFrame()).toContain("用法：/steer 文本");
      expect(approvals.current).toBeDefined();
      for (const character of "/follow-up y n") {
        app.stdin.write(character);
        await settle();
      }
      app.stdin.write("\u001b");
      await settle();
      expect(approvals.current).toBeDefined();
      expect(app.lastFrame()).toContain("保留草稿");
      expect(session.steer).not.toHaveBeenCalled();
      expect(session.followUp).not.toHaveBeenCalled();
      app.stdin.write("\r");
      await expect(decision).resolves.toBe("deny");
    } finally {
      approvals.close();
      app.unmount();
    }
  });

  it("五态控制回执保持 Run/Control 身份，输入消费事实单独显示", async () => {
    const session = createSession();
    const inputId = controlInputId("run-original", "control-original");
    const discardedInputId = controlInputId("run-original", "control-discarded");
    let listener: Parameters<ChatSession["onEvent"]>[0] | undefined;
    session.onEvent = (handler) => {
      listener = handler;
      return () => {};
    };
    const app = render(
      <ChatTUI
        title="控制事实"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={() => {}}
      />,
    );
    try {
      let controls = 0;
      for (const status of ["accepted", "applied", "rejected", "duplicate", "conflict"] as const) {
        vi.mocked(session.steer).mockResolvedValueOnce(controlReceipt(status));
        app.stdin.write(`/steer ${status}\r`);
        await vi.waitFor(() => expect(app.lastFrame()).toContain(`Run run-original · ${status}`));
        expect(session.steer).toHaveBeenNthCalledWith(++controls, status);
        expect(session.steer).toHaveBeenCalledTimes(controls);
      }
      listener?.({ type: "agent_start", agent: "main" });
      listener?.({ type: "text_delta", agent: "main", delta: "流式开头" });
      listener?.({
        type: "input_claimed",
        inputId,
        turnId: "turn-control",
        status: "claimed",
        timestamp: "2026-10-14T00:00:00Z",
      });
      listener?.({ type: "text_delta", agent: "main", delta: "和末尾" });
      listener?.({
        type: "input_discarded",
        inputId: discardedInputId,
        status: "discarded",
        timestamp: "2026-10-14T00:00:01Z",
      });
      await vi.waitFor(() =>
        expect(app.lastFrame()?.replace(/\s/gu, "")).toContain(
          `输入 ${inputId} · claimed · Turn turn-control`.replace(/\s/gu, ""),
        ),
      );
      expect(app.lastFrame()?.replace(/\s/gu, "")).toContain(
        `输入 ${discardedInputId} · discarded`.replace(/\s/gu, ""),
      );
      expect(app.lastFrame()).toContain("流式开头和末尾");
      expect(session.chat).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });
});

function controlReceipt(status: ControlReceipt["status"]): ControlReceipt {
  return { schemaVersion: 1, controlId: "control-original", runId: "run-original", status };
}

function controlApproval(): Parameters<ApprovalQueue["request"]>[0] {
  return {
    approvalId: "control-approval",
    runId: "run-original",
    agent: "main",
    tool: "write",
    args: {},
    argumentsFingerprint: "a".repeat(64),
    risk: "high",
    reason: "保留原审批",
    effect: { operations: ["write"], paths: [], urls: [], reversible: true, declared: true },
  };
}

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
