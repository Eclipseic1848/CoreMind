import "../../../test/setup-env.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { TaskSession } from "./task-session.js";

describe("稳定键沿用真实 ChildRun", () => {
  it.each([false, true])(
    "reuse/limit=%s：重复键不新增子任务，第二键不重置子树上限",
    async (limit) => {
      const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-keyed-child-"));
      let requests = 0;
      const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          requests += 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const [delta, finish_reason] of [
            [{ role: "assistant", content: "子任务完成" }, null],
            [{}, "stop"],
          ]) {
            response.write(
              `data: ${JSON.stringify({ id: "child", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          }
          response.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let session: TaskSession | undefined;
      try {
        const budget = {
          tokens: 500,
          toolCalls: 0,
          costUsd: 0.1,
          wallTimeMs: 3000,
          steps: 1,
          descendants: 0,
        };
        const config = validateConfig({
          schemaVersion: 2,
          name: "稳定键 ChildRun",
          defaultAgent: "main",
          provider: {
            id: "local-probe",
            model: "probe",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          },
          agents: {
            main: {
              delegation: {
                budget: {
                  ...budget,
                  tokens: 1000,
                  costUsd: 0.2,
                  wallTimeMs: 6000,
                  steps: 2,
                  descendants: 1,
                },
                limits: { maxDescendants: 1 },
                targets: { worker: { budget } },
              },
            },
            worker: {},
          },
          runtime: {
            maxRetries: 0,
            maxToolCalls: 3,
            maxSteps: 5,
            maxTokens: 1000,
            maxCostUsd: 1,
            runTimeoutMs: 10000,
          },
          permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
        });
        let pause = true;
        session = await TaskSession.open({
          workspace,
          sessionId: "children",
          runtime: {
            authorityVersion: "one",
            config,
            configDir: workspace,
            approveTool: async () => "allow",
          },
          definitions: [
            {
              type: "child",
              version: 1,
              initialPhase: "a",
              checkpointSchema: { type: "string" },
              phases: {
                async a(context) {
                  await context.runCalls(async ({ executeTool }) => {
                    const args = { target: "worker", task: "读取事实", references: [] };
                    const result = await executeTool("one", "delegate", args);
                    expect(await executeTool("one", "delegate", args)).toEqual(result);
                    if (limit) await executeTool("two", "delegate", args);
                    return null;
                  });
                  if (pause) throw new Error("检查结果复用");
                  return { phase: "a", checkpoint: "完成", done: true };
                },
              },
            },
          ],
        });
        await session.start({ taskId: "job", type: "child", checkpoint: "initial" });
        if (limit) {
          await expect(session.resume("job")).rejects.toMatchObject({
            code: "child_run_policy_escalation",
            message: expect.stringContaining("descendants"),
          });
          expect(session.calls("job").map((call) => call.status)).toEqual(["completed", "failed"]);
        } else {
          await expect(session.resume("job")).rejects.toThrow("检查结果复用");
          pause = false;
          expect(await session.resume("job")).toMatchObject({ status: "completed" });
        }
        expect(requests).toBe(1);
      } finally {
        await session?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
