import "../../../test/setup-env.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { expect, it } from "vitest";
import { CheckpointManager, restoreCheckpoint } from "./checkpoint.js";
import type { RunStore } from "./run-state.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";

it.each(["ask", "assisted", "full"] as const)(
  "%s 拒绝改写不同配置目录、自定义 RunStore 和 Session 的真实状态",
  async (mode) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-state-protection-"));
    const configDir = path.join(cwd, "config");
    const sessionRoot = path.join(cwd, "conversation-history");
    mkdirSync(configDir);
    const store = new FileRunStore(path.join(cwd, "run-history"));
    const previous = {
      version: 1 as const,
      runId: "previous-run",
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "start" as const,
      payload: {},
    };
    await store.append(previous);
    const session = await CoreMindSession.open({ dir: sessionRoot, sessionId: "previous", cwd });
    const internalRoot = readdirSync(sessionRoot, { withFileTypes: true }).find((entry) =>
      entry.isDirectory(),
    )!;
    const internalSession = path.join(
      sessionRoot,
      internalRoot.name,
      readdirSync(path.join(sessionRoot, internalRoot.name))[0]!,
    );
    const businessFile = path.join(cwd, "business.txt");
    writeFileSync(businessFile, "before", "utf8");
    const checkpoints = new CheckpointManager({
      cwd,
      rootDir: path.join(configDir, ".coremind", "checkpoints"),
      runId: "previous-run",
    });
    const checkpoint = (await checkpoints.capture("write", { path: businessFile }))!;
    writeFileSync(businessFile, "after", "utf8");
    await checkpoints.markApplied(checkpoint.checkpointId);
    const qualityFile = path.join(configDir, ".coremind", "quality-overrides.jsonl");
    writeFileSync(qualityFile, "原始审计\n", "utf8");
    let target = "";
    const server = toolServer(() => ({
      name: "write",
      args: { path: target, content: "覆盖框架状态" },
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let approvals = 0;
    try {
      for (const file of [
        store.pathFor(previous.runId),
        checkpoint.snapshotFile,
        session.filePath,
        internalSession,
        qualityFile,
      ]) {
        const before = readFileSync(file, "utf8");
        target = path.relative(cwd, file);
        const runtime = await CoreMindRuntime.create({
          cwd,
          configDir,
          runStore: store,
          config: configFor(server, mode, { enabled: true, dir: sessionRoot }),
          initialPrompt: "执行本地状态保护回归",
          approveTool: async () => {
            approvals += 1;
            return "allow";
          },
        });
        const result = await runtime.run();
        expect(result.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(approvals).toBe(0);
      expect(await store.read(previous.runId)).toEqual([previous]);
      await restoreCheckpoint(checkpoint, cwd);
      expect(readFileSync(businessFile, "utf8")).toBe("before");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

it("默认状态目录受保护，业务写入、审批与 Checkpoint 恢复保持原行为", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-state-business-"));
  let target = ".coremind/runs/new-run.jsonl";
  const server = toolServer(() => ({ name: "write", args: { path: target, content: "after" } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let approvals = 0;
  try {
    const options = {
      cwd,
      configDir: cwd,
      config: configFor(server, "ask"),
      initialPrompt: "写入业务文件",
      approveTool: async () => {
        approvals += 1;
        return "allow" as const;
      },
    };
    const blocked = await (await CoreMindRuntime.create(options)).run();
    expect(blocked.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
    expect(approvals).toBe(0);
    for (const file of ["business.txt", ".coremind/decisions.md", "sessions/business.txt"]) {
      target = file;
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), "before", "utf8");
      const result = await (await CoreMindRuntime.create(options)).run();
      expect(result.outcome.status).toBe("succeeded");
      expect(readFileSync(path.join(cwd, file), "utf8")).toBe("after");
      await restoreCheckpoint(result.checkpoints[0]!, cwd);
      expect(readFileSync(path.join(cwd, file), "utf8")).toBe("before");
    }
    expect(approvals).toBe(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("RunStore 与 Session 混放工作区时仍允许写入业务兄弟文件", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-state-shared-"));
  const store = new FileRunStore(cwd);
  await store.append({
    version: 1,
    runId: "previous-run",
    sequence: 1,
    timestamp: new Date().toISOString(),
    kind: "start",
    payload: {},
  });
  const session = await CoreMindSession.open({ dir: cwd, sessionId: "previous-session", cwd });
  let target = "";
  const server = toolServer(() => ({ name: "write", args: { path: target, content: "after" } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = {
      cwd,
      configDir: cwd,
      runStore: store,
      config: configFor(server, "full", { enabled: true, dir: "." }),
      initialPrompt: "混放目录写入回归",
    };
    for (const file of [store.pathFor("previous-run"), session.filePath]) {
      target = path.relative(cwd, file);
      const before = readFileSync(file, "utf8");
      const result = await (await CoreMindRuntime.create(options)).run();
      expect(result.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    target = "business.txt";
    writeFileSync(path.join(cwd, target), "before", "utf8");
    const result = await (await CoreMindRuntime.create(options)).run();
    expect(result.outcome.status).toBe("succeeded");
    expect(readFileSync(path.join(cwd, target), "utf8")).toBe("after");
    await restoreCheckpoint(result.checkpoints[0]!, cwd);
    expect(readFileSync(path.join(cwd, target), "utf8")).toBe("before");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("未知 RunStore 只保护明确暴露的文件，不误封父目录", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-state-adapter-"));
  const files = new FileRunStore(cwd);
  const store: RunStore = {
    supportedDurability: files.supportedDurability,
    durabilityBoundary: files.durabilityBoundary,
    append: (record) => files.append(record),
    commit: (record, durability) => files.commit(record, durability),
    barrier: (runId, durability) => files.barrier(runId, durability),
    read: (runId) => files.read(runId),
    pathFor: (runId) => files.pathFor(runId),
  };
  let target = "current-run.jsonl";
  const server = toolServer(() => ({ name: "write", args: { path: target, content: "after" } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = {
      cwd,
      configDir: cwd,
      runStore: store,
      config: configFor(server, "full"),
      initialPrompt: "自定义存储写入回归",
    };
    const blocked = await (
      await CoreMindRuntime.create({ ...options, runId: "current-run" })
    ).run();
    expect(blocked.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
    expect((await store.read("current-run")).length).toBeGreaterThan(0);
    target = "business.txt";
    const result = await (await CoreMindRuntime.create(options)).run();
    expect(result.outcome.status).toBe("succeeded");
    expect(readFileSync(path.join(cwd, target), "utf8")).toBe("after");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("Child 未打开 Session 时仍继承父会话的状态保护", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-state-child-session-"));
  const server = toolServer((request) =>
    request.tools?.some((tool) => tool.function?.name === "delegate")
      ? { name: "delegate", args: { target: "child", task: "验证父会话写入边界" } }
      : {
          name: "write",
          args: { path: "parent-session.jsonl", content: "不应改写父会话" },
        },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = configFor(server, "full", { enabled: true, dir: "." });
    const budget = {
      tokens: 800,
      toolCalls: 2,
      costUsd: 1,
      wallTimeMs: 15_000,
      steps: 2,
      descendants: 0,
    };
    config.agents.main!.delegation = {
      budget: { ...budget, descendants: 1 },
      limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
      targets: { child: { budget } },
    };
    config.agents.child = { tools: [{ id: "write" }] };
    config.runtime = {
      maxTurns: 3,
      maxSteps: 5,
      maxToolCalls: 5,
      maxTokens: 3200,
      maxCostUsd: 2,
      runTimeoutMs: 30_000,
    };
    const store = new FileRunStore(path.join(cwd, ".coremind", "runs"));
    const runtime = await CoreMindRuntime.create({
      cwd,
      configDir: cwd,
      config,
      runStore: store,
      sessionId: "parent-session",
      initialPrompt: "验证 Child 的父会话保护",
    });
    const result = await runtime.run();
    const childRunId = result.childRuns?.nodes[0]?.childRunId;
    expect(childRunId).toBeDefined();
    const childRecords = await store.read(childRunId!);
    expect(
      childRecords.some(
        (record) =>
          record.kind === "event" &&
          (record.payload as { event?: { type?: string } }).event?.type === "policy_denied",
      ),
    ).toBe(true);
    expect(readFileSync(path.join(cwd, "parent-session.jsonl"), "utf8")).not.toContain(
      "不应改写父会话",
    );
    await expect(
      CoreMindSession.open({ dir: cwd, sessionId: "parent-session", cwd }),
    ).resolves.toHaveProperty("isNew", false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

function configFor(
  server: ReturnType<typeof createServer>,
  mode: "ask" | "assisted" | "full",
  session?: CoreMindConfig["session"],
): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "状态保护回归",
    provider: {
      id: "probe",
      model: "probe",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    },
    agents: { main: { tools: [{ id: "write" }] } },
    permissions: { mode, workspaceOnly: true, network: "deny" },
    runtime: { maxTurns: 3 },
    ...(session ? { session } : {}),
  };
}

interface FixtureRequest {
  messages: Array<{ role: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function toolServer(next: (request: FixtureRequest) => { name: string; args: unknown }) {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as FixtureRequest;
      const done = payload.messages.some((message) => message.role === "tool");
      const call = done ? undefined : next(payload);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = done
        ? { role: "assistant", content: "完成" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "state-write",
                type: "function",
                function: { name: call!.name, arguments: JSON.stringify(call!.args) },
              },
            ],
          };
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] },
      ]) {
        response.write(`data: ${JSON.stringify({ id: "state-regression", ...chunk })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
}
