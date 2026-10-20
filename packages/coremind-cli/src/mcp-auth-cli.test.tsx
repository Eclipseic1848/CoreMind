import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChatSession, CoreMindConfig, CoreMindRuntimeOptions } from "coremind-ai";
import { CoreMindRuntime } from "coremind-ai";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval.js";
import { runReadlineChat } from "./commands/chat.js";
import { cmdRun } from "./commands/run.js";
import { ChatTUI } from "./tui.js";

const { factory, questioner } = vi.hoisted(() => ({ factory: vi.fn(), questioner: vi.fn() }));
vi.mock("coremind-ai", async (original) => ({
  ...(await original<typeof import("coremind-ai")>()),
  createMcpAuthentication: factory,
  loadConfigFile: async () => ({}),
  parseAndValidate: () => ({ config, warnings: [] }),
  formatMetrics: () => "运行完成",
}));
vi.mock("node:readline/promises", async (original) => {
  const actual = await original<typeof import("node:readline/promises")>();
  return {
    ...actual,
    createInterface: (...args: Parameters<typeof actual.createInterface>) =>
      questioner.getMockImplementation() ? questioner(...args) : actual.createInterface(...args),
  };
});
vi.mock("./observability-format.js", () => ({ formatObservabilityStatus: () => "本地观测" }));

const config = {
  schemaVersion: 2,
  name: "CLI 认证控制",
  agents: { main: {} },
  mcp: {
    servers: {
      remote: {
        transport: "streamable-http",
        url: "https://resource.test/mcp",
        oauth: { issuer: "https://id.test", clientId: "local-client", scopes: ["read"] },
      },
    },
  },
} as unknown as CoreMindConfig;
const authorizationUrl = "https://id.test/a?state=s&code_challenge=c";

afterEach(() => {
  vi.restoreAllMocks();
  factory.mockReset();
  questioner.mockReset();
});

function authentication(pending = true) {
  let activeSignal: AbortSignal | undefined;
  const auth = {
    login: vi.fn(async (server, options) => {
      activeSignal = options.signal;
      await options.onAuthorization(
        {
          transactionId: "login-1",
          server,
          serverIdentity: "a".repeat(64),
          authorizationUrl,
          expiresAt: "2026-10-15T00:00:00Z",
          issuer: "https://id.test",
          clientId: "local-client",
          resource: "https://resource.test/mcp",
          scopes: ["read"],
        },
        options.signal,
      );
      if (pending)
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("登录已取消"), { code: "aborted" }));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, { once: true });
        });
      return {
        status: "authorized",
        transactionId: "login-1",
        server,
        serverIdentity: "a".repeat(64),
      };
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { auth, signal: () => activeSignal, binding: { authentication: auth, config } };
}

function chatSession() {
  return {
    chat: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    onEvent: () => () => {},
    listCheckpoints: () => [],
  } as unknown as ChatSession;
}

it.each(["cancel", "eof", "sigint", "/exit", "!exit"] as const)(
  "readline 登录等待时可 %s，命令与授权 URL 不进入模型",
  async (stop) => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => {
      printed += chunk.toString("utf8");
    });
    const session = chatSession();
    const fixture = authentication();
    const running = runReadlineChat(
      session,
      new ApprovalQueue(true),
      { input, output },
      fixture.binding,
    );
    try {
      input.write("/mcp login remote\n");
      await vi.waitFor(() => expect(fixture.auth.login).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(printed).toContain(authorizationUrl));
      expect(session.chat).not.toHaveBeenCalled();
      if (stop === "cancel") input.write("/mcp cancel\n");
      else if (stop === "eof") input.end();
      else if (stop === "sigint") process.emit("SIGINT");
      else input.write(`${stop}\n`);
      await vi.waitFor(() => expect(fixture.signal()?.aborted).toBe(true));
      if (stop === "cancel") {
        input.write("/mcp logout remote\n");
        await vi.waitFor(() => expect(fixture.auth.logout).toHaveBeenCalledWith("remote"));
        input.write("正常业务\n");
        await vi.waitFor(() => expect(session.chat).toHaveBeenCalledWith("正常业务"));
      }
    } finally {
      input.end();
      await running;
    }
    expect(fixture.auth.close).not.toHaveBeenCalled();
  },
);

it("Ink 登录 URL 只在临时面板显示，取消后清空且不消费模型输入", async () => {
  const session = chatSession();
  const fixture = authentication();
  const app = render(
    <ChatTUI
      title="认证控制"
      session={session}
      approvals={new ApprovalQueue(true)}
      mcp={fixture.binding}
      onExit={() => {}}
    />,
  );
  const command = async (value: string) => {
    for (const character of value) app.stdin.write(character);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write("\r");
  };
  try {
    await command("/mcp login remote");
    await vi.waitFor(() => expect(fixture.auth.login).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(app.lastFrame()).toContain("state=s"));
    expect(session.chat).not.toHaveBeenCalled();
    await command("/mcp cancel");
    await vi.waitFor(() => expect(fixture.signal()?.aborted).toBe(true));
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain("state=s"));
    expect(session.chat).not.toHaveBeenCalled();
  } finally {
    app.unmount();
  }
});

it.each(["busy", "approval"] as const)(
  "Ink %s 期间可输入 /mcp logout 撤权且不消费业务或审批",
  async (mode) => {
    const session = chatSession();
    let finishChat!: () => void;
    const pendingChat = new Promise<never>((_resolve, reject) => {
      finishChat = () => reject(new Error("验收收尾"));
    });
    vi.mocked(session.chat).mockReturnValue(pendingChat);
    const fixture = authentication(false);
    const approvals = new ApprovalQueue(true);
    const app = render(
      <ChatTUI
        title="运行中撤权"
        session={session}
        approvals={approvals}
        mcp={fixture.binding}
        onExit={() => {}}
      />,
    );
    const command = async (value: string) => {
      for (const character of value) {
        app.stdin.write(character);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      app.stdin.write("\r");
    };
    let decision: Promise<unknown> | undefined;
    try {
      await command("/mcp login remote");
      await vi.waitFor(() => expect(app.lastFrame()).toContain("登录成功"));
      await command("运行中任务");
      await vi.waitFor(() => expect(session.chat).toHaveBeenCalledWith("运行中任务"));
      if (mode === "approval") {
        decision = approvals.request({
          approvalId: "approval-auth",
          runId: "run-auth",
          agent: "main",
          tool: "write",
          args: {},
          argumentsFingerprint: "a".repeat(64),
          risk: "high",
          reason: "保留审批",
          effect: { operations: ["write"], paths: [], urls: [], reversible: true, declared: true },
        });
        await vi.waitFor(() => expect(app.lastFrame()).toContain("权限审批"));
      }
      await command("/mcp logout remote");
      await vi.waitFor(() => expect(fixture.auth.logout).toHaveBeenCalledWith("remote"));
      expect(session.chat).toHaveBeenCalledOnce();
      if (mode === "approval") expect(approvals.current?.request.approvalId).toBe("approval-auth");
      expect(fixture.auth.close).not.toHaveBeenCalled();
    } finally {
      finishChat();
      await pendingChat.catch(() => {});
      approvals.close();
      await decision;
      app.unmount();
    }
  },
);

it.each(["headless", "print", "json-events"] as const)(
  "run %s 在任何登录或 Runtime 之前拒绝交互预授权",
  async (mode) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: mode !== "headless",
      configurable: true,
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const create = vi.spyOn(CoreMindRuntime, "create").mockResolvedValue({
      resumedContextLength: 0,
      run: async () => ({ transcript: "正文", outcome: { status: "succeeded" } }),
    } as unknown as CoreMindRuntime);
    try {
      const flags = new Map<string, string | boolean>([["mcp-login", "remote"]]);
      if (mode !== "headless") flags.set(mode, true);
      expect(await cmdRun({ flags, positionals: ["coremind.json"] }, ["coremind.json"])).toBe(1);
      expect(diagnostic).toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  },
);

it("run 在加载准入后、业务 Run 前完成宿主登录，并由同一 owner 关闭", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const fixture = authentication(false);
  factory.mockResolvedValue(fixture.auth);
  const rl = Object.assign(new EventEmitter(), { question: vi.fn(), close: vi.fn() });
  questioner.mockReturnValue(rl);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const run = vi.fn().mockImplementation(async () => {
    expect(fixture.auth.login).toHaveBeenCalledOnce();
    expect(fixture.auth.close).not.toHaveBeenCalled();
    return { transcript: "正文", outcome: { status: "succeeded" } };
  });
  const create = vi
    .spyOn(CoreMindRuntime, "create")
    .mockImplementation(async (options: CoreMindRuntimeOptions) => {
      expect(fixture.auth.login).not.toHaveBeenCalled();
      expect(options.mcpAuthentication).toBe(fixture.auth);
      expect(fixture.auth.close).not.toHaveBeenCalled();
      return { resumedContextLength: 0, run } as unknown as CoreMindRuntime;
    });
  try {
    expect(
      await cmdRun({ flags: new Map([["mcp-login", "remote"]]), positionals: ["coremind.json"] }, [
        "coremind.json",
      ]),
    ).toBe(0);
    expect(factory).toHaveBeenCalledWith({ config });
    expect(create).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(fixture.auth.close).toHaveBeenCalledOnce();
    expect(rl.close).toHaveBeenCalledOnce();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

it("run 预登录时 Ctrl+C 保留 130 退出语义且不创建业务 Run", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const fixture = authentication();
  factory.mockResolvedValue(fixture.auth);
  const rl = Object.assign(new EventEmitter(), { question: vi.fn(), close: vi.fn() });
  questioner.mockReturnValue(rl);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const run = vi.fn();
  const create = vi.spyOn(CoreMindRuntime, "create").mockResolvedValue({
    resumedContextLength: 0,
    run,
  } as unknown as CoreMindRuntime);
  const running = cmdRun(
    { flags: new Map([["mcp-login", "remote"]]), positionals: ["coremind.json"] },
    ["coremind.json"],
  );
  try {
    await vi.waitFor(() => expect(fixture.auth.login).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]![0];
    expect(options.mcpAuthentication).toBe(fixture.auth);
    expect(options.signal?.aborted).toBe(false);
    process.emit("SIGINT");
    expect(await running).toBe(130);
    expect(options.signal?.aborted).toBe(true);
    expect(fixture.signal()).toBe(options.signal);
    expect(run).not.toHaveBeenCalled();
    expect(fixture.auth.close).toHaveBeenCalledOnce();
    expect(rl.close).toHaveBeenCalledOnce();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
});
