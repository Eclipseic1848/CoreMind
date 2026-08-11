import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoreMindRuntime,
  loadConfigFile,
  loadEvaluationSuite,
  parseAndValidate,
  runEvaluationSuite,
} from "coremind-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodingEvalMockServer } from "./_shared/mock-provider.mjs";
import "./engineering-kernel.test.js";

const examplesRoot = path.dirname(fileURLToPath(import.meta.url));
const previousKey = process.env.CODING_MOCK_API_KEY;

beforeAll(() => {
  process.env.CODING_MOCK_API_KEY = "offline-test";
});

afterAll(() => {
  if (previousKey === undefined) delete process.env.CODING_MOCK_API_KEY;
  else process.env.CODING_MOCK_API_KEY = previousKey;
});

describe("真实缺陷仓库确定性评测", () => {
  it("TypeScript Agent 先复现失败，再最小修复并通过目标与回归测试", async () => {
    const projectDir = prepareRepository("typescript-defect");
    expect(run(projectDir, process.execPath, "--test", "tests/discount.test.ts")).not.toBe(0);
    const userDraft = readFileSync(path.join(projectDir, "user-notes.txt"), "utf8");
    const protectedConfig = readFileSync(path.join(projectDir, "coremind.yaml"), "utf8");

    const { result, runtimeResult } = await evaluate("typescript", projectDir);

    expect(
      result.passRate,
      JSON.stringify(
        { attempts: result.attempts, messages: runtimeResult?.messages },
        mapReplacer,
        2,
      ),
    ).toBe(1);
    expect(result.attempts[0]?.graderResults.every((grader) => grader.passed)).toBe(true);
    expect(result.attempts[0]?.metrics).toMatchObject({ toolCalls: 7, toolFailures: 1 });
    expect(runtimeResult?.evaluation.securityFindings).toEqual([]);
    expect(runtimeResult?.releaseReadiness.warnings).toContainEqual(
      expect.stringContaining("不可自动回退"),
    );
    expect(readFileSync(path.join(projectDir, "user-notes.txt"), "utf8")).toBe(userDraft);
    expect(readFileSync(path.join(projectDir, "coremind.yaml"), "utf8")).toBe(protectedConfig);
    expect(run(projectDir, process.execPath, "--test")).toBe(0);
  });

  it("Python Agent 先复现失败，再最小修复并通过目标与回归测试", async () => {
    const projectDir = prepareRepository("python-defect");
    expect(run(projectDir, "python", "-m", "unittest", "tests.test_tax")).not.toBe(0);
    const userDraft = readFileSync(path.join(projectDir, "user-notes.txt"), "utf8");
    const protectedEnv = readFileSync(path.join(projectDir, ".env.example"), "utf8");

    const { result, runtimeResult } = await evaluate("python", projectDir);

    expect(
      result.passRate,
      JSON.stringify(
        { attempts: result.attempts, messages: runtimeResult?.messages },
        mapReplacer,
        2,
      ),
    ).toBe(1);
    expect(result.attempts[0]?.graderResults.every((grader) => grader.passed)).toBe(true);
    expect(result.attempts[0]?.metrics).toMatchObject({ toolCalls: 7, toolFailures: 1 });
    expect(runtimeResult?.evaluation.securityFindings).toEqual([]);
    expect(runtimeResult?.releaseReadiness.warnings).toContainEqual(
      expect.stringContaining("不可自动回退"),
    );
    expect(readFileSync(path.join(projectDir, "user-notes.txt"), "utf8")).toBe(userDraft);
    expect(readFileSync(path.join(projectDir, ".env.example"), "utf8")).toBe(protectedEnv);
    expect(run(projectDir, "python", "-m", "unittest", "discover", "-s", "tests")).toBe(0);
  });
});

async function evaluate(profile: "typescript" | "python", projectDir: string) {
  const server = createCodingEvalMockServer(profile) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const raw = (await loadConfigFile(path.join(projectDir, "coremind.yaml"))) as Record<
      string,
      unknown
    >;
    raw.provider = {
      ...(raw.provider as Record<string, unknown>),
      baseUrl: `http://127.0.0.1:${port}/v1`,
    };
    const config = parseAndValidate(raw).config;
    let runtimeResult: Awaited<ReturnType<InstanceType<typeof CoreMindRuntime>["run"]>> | undefined;
    const result = await runEvaluationSuite({
      config,
      configDir: projectDir,
      cwd: projectDir,
      suite: await loadEvaluationSuite(path.join(projectDir, "evals", "scenarios.yaml")),
      runtimeFactory: async (options) => {
        const runtime = await CoreMindRuntime.create(options);
        return {
          run: async () => {
            runtimeResult = await runtime.run();
            return runtimeResult;
          },
        };
      },
    });
    return { result, runtimeResult };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function mapReplacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

function prepareRepository(id: string): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), `coremind-${id}-`));
  cpSync(path.join(examplesRoot, id), projectDir, { recursive: true });
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "coremind@example.invalid");
  git(projectDir, "config", "user.name", "CoreMind Eval");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "defect baseline");
  writeFileSync(
    path.join(projectDir, "user-notes.txt"),
    "用户自己的未提交草稿，必须原样保留。\n",
    "utf8",
  );
  return projectDir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function run(cwd: string, command: string, ...args: string[]): number | null {
  return spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 30_000 }).status;
}
