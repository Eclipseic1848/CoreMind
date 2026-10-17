import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig, ToolConfig } from "coremind-config";
import { expect, it, type TestContext, vi } from "vitest";
import type { ProjectCodeTrustRequest } from "./project-code-trust.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions } from "./runtime.js";

const script = (name = "project_probe") => `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(new URL("./import-canary.log", import.meta.url), ${JSON.stringify(`${name}\n`)}, "utf8");
export default {
  name: ${JSON.stringify(name)}, description: "宿主加载信任验收",
  parameters: {type:"object", properties:{path:{type:"string"}}, required:["path"]},
  execute: async () => {
    writeFileSync(new URL("./execute-canary.log", import.meta.url), "executed", "utf8");
    return {content:[{type:"text", text:"已执行"}], details:{}};
  }
};`;
const entry = (name = "probe.mjs"): ToolConfig => ({
  path: name,
  effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
});

async function withProject(
  context: TestContext,
  action: (fixture: {
    directory: string;
    config: CoreMindConfig;
    requests: unknown[];
    make: (options?: Partial<CoreMindRuntimeOptions>) => Promise<CoreMindRuntime>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-project-trust-"));
  const controller = new AbortController();
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const tool = requests.length === 1;
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "project-tool",
                type: "function",
                function: { name: "project_probe", arguments: '{"path":"execute-canary.log"}' },
              },
            ],
          }
        : { role: "assistant", content: "完成" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [change, finish] of [
        [delta, null],
        [{}, tool ? "tool_calls" : "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: `trust-${requests.length}`,
            choices: [{ index: 0, delta: change, finish_reason: finish }],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
  });
  context.onTestFinished(() => {
    controller.abort();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(path.join(directory, "probe.mjs"), script(), "utf8");
    const config: CoreMindConfig = {
      schemaVersion: 3,
      name: "project-trust",
      provider: {
        id: "project-trust",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: "probe",
        apiKeyEnv: "COREMIND_PROJECT_TRUST_TEST_KEY",
      },
      agents: { main: {} },
      tools: [entry()],
      permissions: { mode: "full", workspaceOnly: true, network: "deny" },
      runtime: { maxTurns: 3, maxRetries: 0, runTimeoutMs: 5000 },
    };
    await action({
      directory,
      config,
      requests,
      make: (options = {}) =>
        CoreMindRuntime.create({
          config,
          configDir: directory,
          cwd: directory,
          initialPrompt: "执行 project_probe",
          env: { COREMIND_PROJECT_TRUST_TEST_KEY: "test-only-key" },
          signal: controller.signal,
          ...options,
        }),
    });
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const decision of ["missing", "deny", "throw"] as const) {
  it(`${decision}：拒绝 create，真实模块顶层和 Provider 均零执行`, async (context) => {
    await withProject(context, async ({ make, directory, requests }) => {
      const approveProjectCode =
        decision === "missing"
          ? undefined
          : decision === "deny"
            ? () => false
            : () => {
                throw new Error("宿主拒绝，不应向外带出此异常正文");
              };
      await expect(make({ approveProjectCode })).rejects.toMatchObject({
        code: "execution_security_violation",
      });
      expect(existsSync(path.join(directory, "import-canary.log"))).toBe(false);
      expect(requests).toHaveLength(0);
    });
  });
}

it("同一批包含全局继承、独立 Agent、deferred 和同源去重，第一条 import 前一次决定", async (context) => {
  await withProject(context, async ({ make, directory, requests, config }) => {
    await writeFile(path.join(directory, "other.mjs"), script("other_probe"), "utf8");
    const approveProjectCode = vi.fn((request: ProjectCodeTrustRequest) => {
      expect(existsSync(path.join(directory, "import-canary.log"))).toBe(false);
      expect(request.sources).toHaveLength(2);
      expect(request.sources.map((source: { path: string }) => path.basename(source.path))).toEqual(
        ["other.mjs", "probe.mjs"],
      );
      expect(request.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        request.sources.every((source: { sha256: string }) =>
          /^[0-9a-f]{64}$/u.test(source.sha256),
        ),
      ).toBe(true);
      return true;
    });
    await make({
      approveProjectCode,
      config: {
        ...config,
        schemaVersion: 3,
        name: "scope",
        tools: [entry()],
        agents: {
          main: {},
          duplicate: { tools: [entry("./probe.mjs")] },
          independent: { tools: [{ ...entry("other.mjs"), exposure: "deferred" }] },
        },
      },
    });
    expect(approveProjectCode).toHaveBeenCalledTimes(1);
    expect(
      (await readFile(path.join(directory, "import-canary.log"), "utf8")).trim().split("\n").sort(),
    ).toEqual(["other_probe", "project_probe"]);
    expect(requests).toHaveLength(0);
  });
});

it("宿主同意后入口被替换，在真实 import 前拒绝新顶层", async (context) => {
  await withProject(context, async ({ make, directory, requests }) => {
    await expect(
      make({
        approveProjectCode: async () => {
          await writeFile(path.join(directory, "probe.mjs"), script("replaced_probe"), "utf8");
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "execution_security_violation" });
    expect(existsSync(path.join(directory, "import-canary.log"))).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

it("Node 已缓存模块的新 Runtime 仍需本次宿主决定", async (context) => {
  await withProject(context, async ({ make, directory }) => {
    await make({ approveProjectCode: () => true });
    const before = await readFile(path.join(directory, "import-canary.log"), "utf8");
    await expect(make()).rejects.toMatchObject({ code: "execution_security_violation" });
    expect(await readFile(path.join(directory, "import-canary.log"), "utf8")).toBe(before);
  });
});

it("批准后切换目录链接的目标，不能加载未批准的新入口", async (context) => {
  await withProject(context, async ({ make, directory, requests, config }) => {
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    const alias = path.join(directory, "alias");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "probe.mjs"), script("first_probe"), "utf8");
    await writeFile(path.join(second, "probe.mjs"), script("second_probe"), "utf8");
    await symlink(first, alias, "junction");
    await expect(
      make({
        config: { ...config, tools: [entry("alias/probe.mjs")] },
        approveProjectCode: async () => {
          await unlink(alias);
          await symlink(second, alias, "junction");
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "execution_security_violation" });
    expect(existsSync(path.join(first, "import-canary.log"))).toBe(false);
    expect(existsSync(path.join(second, "import-canary.log"))).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

it("批准回调取消后不执行模块", async (context) => {
  await withProject(context, async ({ make, directory }) => {
    const controller = new AbortController();
    await expect(
      make({
        signal: controller.signal,
        approveProjectCode: () => {
          controller.abort();
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(existsSync(path.join(directory, "import-canary.log"))).toBe(false);
  });
});

it("预检缺失文件在批准回调中出现，不能借其他入口的同意加载", async (context) => {
  await withProject(context, async ({ make, directory, requests, config }) => {
    await expect(
      make({
        config: { ...config, tools: [entry(), entry("late.mjs")] },
        approveProjectCode: async (request) => {
          expect(request.sources).toHaveLength(1);
          await writeFile(
            path.join(directory, "late.mjs"),
            script("unapproved_late_probe"),
            "utf8",
          );
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "execution_security_violation" });
    expect(await readFile(path.join(directory, "import-canary.log"), "utf8")).toBe(
      "project_probe\n",
    );
    expect(requests).toHaveLength(0);
  });
});

it("无配置脚本时无需决定，不触发宿主回调", async (context) => {
  await withProject(context, async ({ make, directory, config }) => {
    const approveProjectCode = vi.fn(() => false);
    await make({
      config: { ...config, tools: [], schemaVersion: 2, name: "no-script", agents: { main: {} } },
      approveProjectCode,
    });
    expect(approveProjectCode).not.toHaveBeenCalled();
    expect(existsSync(path.join(directory, "import-canary.log"))).toBe(false);
  });
});

for (const allowed of [false, true]) {
  it(`加载同意与工具执行审批独立：工具决定 ${allowed}`, async (context) => {
    await withProject(context, async ({ make, directory, requests, config }) => {
      const approveTool = vi.fn(async () => (allowed ? ("allow" as const) : ("deny" as const)));
      const runtime = await make({
        approveProjectCode: () => true,
        approveTool,
        config: {
          ...config,
          schemaVersion: 3,
          name: "separate-approval",
          tools: [entry()],
          agents: { main: {} },
          permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        },
      });
      const result = await runtime.run();
      expect(approveTool).toHaveBeenCalledTimes(1);
      expect(requests.length).toBeGreaterThan(0);
      expect(existsSync(path.join(directory, "import-canary.log"))).toBe(true);
      expect(existsSync(path.join(directory, "execute-canary.log"))).toBe(allowed);
      if (allowed) expect(result.outcome.status).toBe("succeeded");
    });
  });
}
