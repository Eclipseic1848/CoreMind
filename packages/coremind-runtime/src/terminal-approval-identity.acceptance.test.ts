import "../../../test/setup-env.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

type ApprovalIdentity = { callId?: string; stepId?: string };
type IdentifiedApproval = ToolApprovalRequest & ApprovalIdentity;
const content = "审批身份真实读取正文-739027";

it.each(["batch", "workflow"] as const)(
  "%s 同名同参审批沿原调用身份关联，不猜名称或指纹",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-approval-identity-"));
    const approvals: IdentifiedApproval[] = [];
    const releases = new Map<string, () => void>();
    const requests: unknown[] = [];
    const failures: unknown[] = [];
    let running: Promise<RunResult> | undefined;
    let runtime: CoreMindRuntime | undefined;
    let draining = false;
    const model = createServer((request, response) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        try {
          const body = JSON.parse(text) as { messages: Array<{ role: string; content?: unknown }> };
          requests.push(body);
          const finished = body.messages.some((message) => message.role === "tool");
          if (finished) expect(JSON.stringify(body.messages)).toContain(content);
          const ids = mode === "batch" ? ["call-left", "call-right"] : ["same-call"];
          const delta = finished
            ? { role: "assistant", content: "读取完成" }
            : {
                role: "assistant",
                tool_calls: ids.map((id, index) => ({
                  index,
                  id,
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
                })),
              };
          send(response, delta, finished ? "stop" : "tool_calls");
        } catch (error) {
          failures.push(error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      });
    });
    try {
      await writeFile(path.join(directory, "notes.txt"), content, "utf8");
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "并行审批身份验收",
        provider: {
          id: "approval-probe",
          model: "probe",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
          baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
        },
        agents: { main: { tools: [{ id: "read" }] } },
        permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        runtime: { maxTurns: 8, maxToolCalls: 8, maxRetries: 0, runTimeoutMs: 10_000 },
        ...(mode === "workflow"
          ? {
              workflow: [
                {
                  id: "parallel",
                  type: "parallel" as const,
                  steps: ["a", "b"].map((id) => ({
                    id,
                    type: "prompt" as const,
                    agent: "main",
                    input: id,
                  })),
                },
              ],
            }
          : {}),
      };
      runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        initialPrompt: "读取 notes.txt",
        approveTool: (request) => {
          approvals.push(request);
          // 原生单批先串行准备调用；只有独立 Workflow 分支能同时等待审批。
          if (mode === "batch" || draining) return Promise.resolve("allow");
          return new Promise<"allow">((resolve) => {
            // 清理只使用原有 approvalId，缺少新身份也不能让红例挂住。
            releases.set(request.approvalId, () => resolve("allow"));
          });
        },
      });
      running = runtime.run();
      void running.catch(() => {});
      await vi.waitFor(() => expect(approvals).toHaveLength(2), { timeout: 5_000 });
      expect(new Set(approvals.map((request) => request.approvalId)).size).toBe(2);
      expect(new Set(approvals.map((request) => request.argumentsFingerprint)).size).toBe(1);
      expect(approvals.map((request) => request.args)).toEqual([
        { path: "notes.txt" },
        { path: "notes.txt" },
      ]);
      expect(
        approvals.every((request) => request.agent === "main" && request.tool === "read"),
      ).toBe(true);
      if (mode === "batch") {
        expect(approvals.map((request) => request.callId).sort()).toEqual([
          "call-left",
          "call-right",
        ]);
        expect(approvals.every((request) => !Object.hasOwn(request, "stepId"))).toBe(true);
      } else {
        expect(approvals.map((request) => request.callId)).toEqual(["same-call", "same-call"]);
        expect(approvals.map((request) => request.stepId).sort()).toEqual(["a", "b"]);
      }
      // Workflow 两项真实同时等待后反向释放，不用先后次序替代身份。
      if (mode === "workflow")
        for (const request of [...approvals].reverse()) releases.get(request.approvalId)!();
      const result = await running;
      expect(result.outcome.status).toBe("succeeded");
      expect(requests).toHaveLength(mode === "batch" ? 2 : 4);
      const required = result.trace
        .map((entry) => entry.event)
        .filter(
          (
            event,
          ): event is Extract<CoreMindEvent, { type: "approval_required" }> & ApprovalIdentity =>
            event.type === "approval_required",
        );
      const resolved = result.trace
        .map((entry) => entry.event)
        .filter((event) => event.type === "approval_resolved");
      expect(required).toHaveLength(2);
      expect(resolved).toHaveLength(2);
      for (const request of approvals) {
        const event = required.find((candidate) => candidate.approvalId === request.approvalId)!;
        expect(event).toMatchObject({
          runId: result.runId,
          agent: request.agent,
          callId: request.callId,
        });
        expect(event.stepId).toBe(request.stepId);
        const decision = resolved.find((candidate) => candidate.approvalId === request.approvalId)!;
        expect(decision).toMatchObject({ runId: result.runId, decision: "allow" });
        for (const field of ["callId", "stepId", "agent"])
          expect(Object.hasOwn(decision, field)).toBe(false);
      }
      expect(failures).toEqual([]);
    } finally {
      draining = true;
      for (const release of releases.values()) release();
      if (running) await running;
      if (runtime) expect(await runtime.waitForQuiescence()).toBe(true);
      model.closeAllConnections();
      if (model.listening) await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  },
);

function send(response: ServerResponse, delta: object, reason: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [change, finish] of [
    [delta, null],
    [{}, reason],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "approval-identity", choices: [{ index: 0, delta: change, finish_reason: finish }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
