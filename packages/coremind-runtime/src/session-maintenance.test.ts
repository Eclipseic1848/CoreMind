import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import { buildProviderRuntime } from "./provider.js";
import { FileRunStore, RunStateJournal } from "./run-state.js";
import type { CoreMindSession } from "./session.js";
import { compactSessionInRun } from "./session-maintenance.js";

describe("摘要认证", () => {
  it.each(["env", "secretRef"])("内置 Provider 摘要复用 %s 显式凭据", async (source) => {
    const key = "test-only-summary-credential";
    const provider = await buildProviderRuntime(
      {
        id: "deepseek",
        model: "deepseek-chat",
        ...(source === "env"
          ? { apiKeyEnv: "SUMMARY_TEST_KEY" }
          : { apiKeySecretRef: { secretRef: "summary-test" } }),
      },
      { SUMMARY_TEST_KEY: key },
      { resolve: async () => key },
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${key}`);
      const chunks = [
        {
          id: "summary",
          choices: [
            { index: 0, delta: { role: "assistant", content: "摘要" }, finish_reason: null },
          ],
        },
        { id: "summary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const session = {
      appendMaintenanceRecord: vi.fn(async () => {}),
      maybeCompact: async (models: typeof provider.models, model: typeof provider.model) => {
        await models.completeSimple(model, {
          systemPrompt: "生成摘要",
          messages: [{ role: "user", content: "摘要", timestamp: 0 }],
        });
        return true;
      },
    } as unknown as CoreMindSession;
    const journal = new RunStateJournal(
      "summary",
      new FileRunStore(mkdtempSync(path.join(tmpdir(), "summary-auth-"))),
    );
    await journal.start({ configName: "summary" });
    try {
      await compactSessionInRun({
        runId: "summary",
        agent: "main",
        session,
        models: provider.models,
        model: provider.model,
        apiKeyOverride: provider.apiKeyOverride,
        budget: new RunBudgetController(resolveRuntimeLimits({}, {}), () => {}),
        journal,
        signal: new AbortController().signal,
        emit: () => {},
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(session.appendMaintenanceRecord).mock.calls)).not.toContain(
        key,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
