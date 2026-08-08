import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CoreMindConfig,
  checkProject,
  loadConfigFile,
  loadEvaluationSuite,
  parseAndValidate,
  runEvaluationSuite,
} from "coremind-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoldenMockServer } from "./_shared/mock-provider.mjs";

const goldenRoot = path.dirname(fileURLToPath(import.meta.url));
const previousKey = process.env.GOLDEN_MOCK_API_KEY;

beforeAll(() => {
  process.env.GOLDEN_MOCK_API_KEY = "offline-test";
});

afterAll(() => {
  if (previousKey === undefined) delete process.env.GOLDEN_MOCK_API_KEY;
  else process.env.GOLDEN_MOCK_API_KEY = previousKey;
});

describe("四个黄金示例", () => {
  it("四个项目的 Config v2 与 standard 项目材料均通过", async () => {
    for (const id of [
      "faq-order-assistant",
      "contract-review-workflow",
      "python-data-analysis",
      "bounded-research-agent",
    ]) {
      const projectDir = path.join(goldenRoot, id);
      const config = parseAndValidate(
        await loadConfigFile(path.join(projectDir, "coremind.yaml")),
      ).config;
      const report = await checkProject({ config, projectDir });
      expect(report.passed, `${id}: ${JSON.stringify(report.findings)}`).toBe(true);
    }
  });

  it("FAQ/订单助手真实调用 TypeScript 工具并通过正反场景", async () => {
    await withServer("order", async (baseUrl) => {
      const result = await evaluate("faq-order-assistant", baseUrl, async () => "allow");
      expect(result.passRate).toBe(1);
      expect(result.totalRuns).toBe(2);
      expect(result.attempts.every((attempt) => attempt.runId)).toBe(true);
    });
  });

  it("合同审核按固定三步 Workflow 输出可校验 JSON", async () => {
    await withServer("contract", async (baseUrl) => {
      const result = await evaluate("contract-review-workflow", baseUrl);
      expect(result.passRate).toBe(1);
      const output = JSON.parse(result.attempts[0]?.transcript ?? "") as {
        riskLevel?: string;
        requiresHumanReview?: boolean;
      };
      expect(output).toMatchObject({ riskLevel: "high", requiresHumanReview: true });
    });
  });

  it("受控调查经过人工审批、工具预算和双 Agent Trace", async () => {
    const approvals: string[] = [];
    await withServer("research", async (baseUrl) => {
      const result = await evaluate("bounded-research-agent", baseUrl, async (request) => {
        approvals.push(request.tool);
        return "allow";
      });
      expect(result.passRate).toBe(1);
      expect(approvals).toEqual(["search_knowledge"]);
      expect(result.attempts[0]?.runId && result.attempts[0].outcome.status === "succeeded").toBe(
        true,
      );
    });
  });
});

async function evaluate(
  id: string,
  baseUrl: string,
  approveTool?: Parameters<typeof runEvaluationSuite>[0]["approveTool"],
) {
  const projectDir = path.join(goldenRoot, id);
  const config = await loadConfig(projectDir, baseUrl);
  return runEvaluationSuite({
    config,
    configDir: projectDir,
    cwd: projectDir,
    suite: await loadEvaluationSuite(path.join(projectDir, "evals", "scenarios.yaml")),
    approveTool,
  });
}

async function loadConfig(projectDir: string, baseUrl: string): Promise<CoreMindConfig> {
  const raw = (await loadConfigFile(path.join(projectDir, "coremind.yaml"))) as Record<
    string,
    unknown
  >;
  const provider = raw.provider as Record<string, unknown>;
  raw.provider = { ...provider, baseUrl };
  return parseAndValidate(raw).config;
}

async function withServer(
  profile: string,
  operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createGoldenMockServer(profile) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await operation(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
