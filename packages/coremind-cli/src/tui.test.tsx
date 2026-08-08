import type { ChatSession } from "coremind-ai";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval.js";
import { ChatTUI } from "./tui.js";

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

describe("Windows TUI 交互验收", () => {
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
    });
    await settle();
    expect(app.lastFrame()).toContain("权限审批：write（high）");
    app.stdin.write("y");
    await expect(decision).resolves.toBe("allow");
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
});

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
