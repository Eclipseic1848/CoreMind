import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function expectPinnedActions(workflow: {
  jobs: Record<string, { steps?: Array<{ uses?: string }> }>;
}) {
  const actionReferences = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.uses)
    .filter((uses): uses is string => Boolean(uses) && !uses.startsWith("./"));

  expect(actionReferences.length).toBeGreaterThan(0);
  for (const reference of actionReferences) {
    expect(reference, `${reference} 必须固定到完整提交 SHA`).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
  }
}

describe("GitHub Actions 收口合同", () => {
  it("Release 事件先从 main 派发文档部署，手动触发仍直接部署", () => {
    const workflow = parse(readFileSync(".github/workflows/docs.yml", "utf8"));

    expect(workflow.on).toHaveProperty("release");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.jobs["trigger-release"].if).toContain("release");
    expect(workflow.jobs["trigger-release"].permissions.actions).toBe("write");
    expect(workflow.jobs["trigger-release"].steps[0].run).toContain("--ref main");
    expect(workflow.jobs.deploy.if).toContain("workflow_dispatch");
    expect(workflow.jobs.deploy.environment.name).toBe("github-pages");
  });

  it("双平台工程 CI 为 PR 与 main 提供稳定快速门禁", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const checkout = workflow.jobs.engineering.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const commands = workflow.jobs.engineering.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");

    expect(workflow.name).toBe("Engineering CI");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.jobs.engineering.name).toContain("Engineering");
    expect(workflow.jobs.engineering.strategy.matrix.os).toEqual([
      "ubuntu-latest",
      "windows-latest",
    ]);
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(commands).toContain("npm run typecheck");
    expect(commands).toContain("npm run security:audit");
    expect(commands).toContain("npm run check:docs");
    expect(commands).toContain("npm run test:engineering");
    expect(commands).toContain("python -W error::ResourceWarning -m unittest discover");
    expect(commands).toContain("COREMIND_JOB_STARTED_EPOCH");
    expect(commands).toContain("GITHUB_STEP_SUMMARY");
    for (const heavyCommand of [
      "npm run test:stability",
      "npm run test:coverage",
      "npm run acceptance:tty",
      "npm run release:check-npm",
      "npm run acceptance:rc",
      "npm run providers:certify",
    ]) {
      expect(commands).not.toContain(heavyCommand);
    }
  });

  it("候选资格门承接完整离线矩阵且真实 Provider 认证只能显式手动触发", () => {
    const workflow = parse(readFileSync(".github/workflows/candidate-qualification.yml", "utf8"));
    const candidateCommands = workflow.jobs.candidate.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    const providerCommands = workflow.jobs["provider-certification"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");

    expect(workflow.name).toBe("Candidate Qualification");
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.workflow_dispatch.inputs.qualification_mode.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.qualification_mode.default).toBe(
      "offline-rehearsal",
    );
    expect(workflow.jobs.candidate.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    for (const command of [
      "npm run test:stability",
      "npm run test:coverage",
      "npm run acceptance:tty",
      "npm run release:check-npm",
      "npm run release:test-npm",
      "npm run release:test-source",
      "npm run acceptance:rc -- --defer-provider-certification",
    ]) {
      expect(candidateCommands).toContain(command);
    }
    expect(candidateCommands).toContain("COREMIND_JOB_STARTED_EPOCH");
    expect(candidateCommands).toContain("GITHUB_STEP_SUMMARY");
    expect(candidateCommands).not.toContain("npm run providers:certify");
    expect(workflow.jobs["provider-certification"].if).toContain("workflow_dispatch");
    expect(workflow.jobs["provider-certification"].if).toContain("strict-provider");
    expect(providerCommands).toContain("npm run providers:certify");
    expect(providerCommands).toContain("npm run release:preflight -- --allow-dirty");
    expect(providerCommands).not.toContain("--defer-provider-certification");
    expect(workflow.jobs.qualified.name).toBe("Candidate qualified");
    expect(workflow.jobs.qualified.if).toContain("strict-provider");
  });

  it("快速测试显式列出工程项目，候选三连跑仍覆盖完整 npm test", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const engineeringConfig = readFileSync("vitest.engineering.config.ts", "utf8");

    expect(manifest.scripts.test).toBe("vitest run");
    expect(manifest.scripts["test:stability"]).toContain("scripts/test-stability.mjs");
    expect(manifest.scripts["test:engineering"]).toContain("vitest.engineering.config.ts");
    expect(engineeringConfig).toContain('"packages/*"');
    expect(engineeringConfig).toContain("vitest.input-receipt-acceptance.config.ts");
    expect(engineeringConfig).toContain("vitest.host-shell.config.ts");
    expect(engineeringConfig).toContain("examples/coding-evals/vitest.config.ts");
    expect(engineeringConfig).toContain("scripts/vitest.config.ts");
    expect(engineeringConfig).not.toContain("trusted-tool-fault-matrix");
    expect(engineeringConfig).not.toContain("phase2-baseline");
  });

  it("Release Please 以非 manifest 入口锁定手动版本并转为草稿 PR", () => {
    const workflow = parse(readFileSync(".github/workflows/release-please.yml", "utf8"));
    const manifest = JSON.parse(readFileSync(".release-please-manifest.json", "utf8"));
    const step = workflow.jobs.release.steps.find((item: { uses?: string }) =>
      item.uses?.startsWith("googleapis/release-please-action@"),
    );

    expect(workflow.on.workflow_dispatch.inputs.release_as.required).toBe(true);
    expect(workflow.permissions.contents).toBe("write");
    expect(workflow.permissions["pull-requests"]).toBe("write");
    expect(step.uses).toMatch(/^googleapis\/release-please-action@[0-9a-f]{40}$/u);
    expect(step.with["release-type"]).toBe("node");
    expect(step.with.path).toBe(".");
    expect(step.with["release-as"]).toContain("release_as");
    expect(step.with["config-file"]).toBeUndefined();
    expect(step.with["manifest-file"]).toBeUndefined();
    expect(step.with["skip-github-release"]).toBe(true);
    const draftStep = workflow.jobs.release.steps.find(
      (item: { name?: string }) => item.name === "转为草稿发布 PR",
    );
    expect(draftStep.if).toContain("steps.release.outputs.pr");
    expect(draftStep.env.GH_REPO).toContain("github.repository");
    expect(draftStep.run).toContain("gh pr ready");
    expect(draftStep.run).toContain("--undo");
    expect(manifest["."]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("统一发布工作流一次构建并分别通过受保护环境发布 npm 与 PyPI", () => {
    const workflow = parse(readFileSync(".github/workflows/publish-pypi.yml", "utf8"));
    const serialized = JSON.stringify(workflow);
    const buildCommands = workflow.jobs.build.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    const workspaceBuildIndex = buildCommands.indexOf("npm run build");
    const checkIndex = buildCommands.indexOf("npm run check");
    const bundleIndex = buildCommands.indexOf("npm run release:bundle");

    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(workspaceBuildIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(workspaceBuildIndex);
    expect(bundleIndex).toBeGreaterThan(checkIndex);
    expect(workflow.jobs.npm.environment.name).toBe("npm");
    expect(workflow.jobs.npm.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.npm.needs).toContain("build");
    expect(workflow.jobs.pypi.environment.name).toBe("pypi");
    expect(workflow.jobs.pypi.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.pypi.needs).toContain("build");
    expect(serialized).toContain("verify-pypi-artifact.mjs");
    expect(serialized).not.toContain("skip-existing");
    expect(workflow.jobs.attest.permissions.attestations).toBe("write");
    expect(workflow.jobs.attest.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.release.needs).toEqual(expect.arrayContaining(["npm", "pypi", "attest"]));
    expect(workflow.jobs.release.permissions.actions).toBe("write");
    const releaseCommands = workflow.jobs.release.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(releaseCommands).toContain("gh workflow run docs.yml --ref main");
    expect(releaseCommands).toContain("cmp --silent");
    expect(releaseCommands).not.toContain("--clobber");
    expect(workflow.jobs.build.needs).toBe("candidate");
    const candidateCommands = workflow.jobs.candidate.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(candidateCommands).toContain("git fetch origin main --no-tags");
    expect(candidateCommands).toContain("git rev-parse FETCH_HEAD");
    expect(candidateCommands).toContain("actions/workflows/candidate-qualification.yml/runs");
    expect(candidateCommands).toContain("Candidate qualified");
    expect(candidateCommands).toContain("--verify-manual-only");
    expect(serialized).not.toContain("NODE_AUTH_TOKEN");
    expect(serialized).toContain("npm@11.5.1");
    expect(serialized).toContain("build==1.5.0");
    expect(serialized).not.toContain("build==1.5.1");
    for (const jobName of ["attest", "npm", "pypi", "release"]) {
      const commands = workflow.jobs[jobName].steps
        .map((step: { run?: string }) => step.run ?? "")
        .join("\n");
      expect(commands).toContain("sha256sum --check SHA256SUMS.txt");
    }
  });

  it("所有外部 Action 固定完整 SHA，并由 Dependabot 维护", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/candidate-qualification.yml",
      ".github/workflows/docs.yml",
      ".github/workflows/release-please.yml",
      ".github/workflows/publish-pypi.yml",
    ]) {
      expectPinnedActions(parse(readFileSync(file, "utf8")));
    }

    const dependabot = parse(readFileSync(".github/dependabot.yml", "utf8"));
    const ecosystems = dependabot.updates.map(
      (update: { "package-ecosystem": string }) => update["package-ecosystem"],
    );
    expect(ecosystems).toEqual(expect.arrayContaining(["github-actions", "npm", "pip"]));
  });

  it("真实子进程长链路项目显式声明 15 秒测试 Harness 上限", () => {
    for (const file of [
      "packages/coremind-runtime/vitest.config.ts",
      "packages/coremind-tools/vitest.config.ts",
    ]) {
      const config = readFileSync(file, "utf8");
      expect(config).toContain("defineProject");
      expect(config).toContain("testTimeout: 15_000");
    }
  });

  it("子进程验收、故障矩阵与时延验收按资源隔离顺序运行", () => {
    const rootConfig = readFileSync("vitest.config.ts", "utf8");
    const toolsConfig = readFileSync("packages/coremind-tools/vitest.config.ts", "utf8");
    const cliConfig = readFileSync("packages/coremind-cli/vitest.config.ts", "utf8");
    const goldenConfig = readFileSync("examples/golden/vitest.config.ts", "utf8");
    const codingEvalsConfig = readFileSync("examples/coding-evals/vitest.config.ts", "utf8");
    const hostShellConfig = readFileSync(
      "packages/coremind-tools/vitest.host-shell.config.ts",
      "utf8",
    );
    const faultMatrixConfig = readFileSync(
      "scripts/vitest.trusted-tool-fault-matrix.config.ts",
      "utf8",
    );
    const inputReceiptConfig = readFileSync(
      "packages/coremind-runtime/vitest.input-receipt-acceptance.config.ts",
      "utf8",
    );

    expect(rootConfig).toContain("packages/coremind-tools/vitest.host-shell.config.ts");
    expect(toolsConfig).toContain("src/host-shell.test.ts");
    for (const config of [cliConfig, goldenConfig, codingEvalsConfig]) {
      expect(config).toContain("groupOrder: 1");
    }
    expect(hostShellConfig).toContain('include: ["src/host-shell.test.ts"]');
    expect(hostShellConfig).toContain("fileParallelism: false");
    expect(hostShellConfig).toContain("groupOrder: 2");
    expect(hostShellConfig).toContain("testTimeout: 60_000");
    expect(faultMatrixConfig).toContain("groupOrder: 2");
    expect(inputReceiptConfig).toContain("groupOrder: 3");
  });

  it("正式产物基线采集在独立资源组运行", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const rootConfig = readFileSync("vitest.config.ts", "utf8");
    const releaseConfig = readFileSync("scripts/vitest.config.ts", "utf8");
    const baselineConfig = readFileSync("scripts/vitest.phase2-baseline.config.ts", "utf8");

    expect(rootConfig).toContain("scripts/vitest.phase2-baseline.config.ts");
    expect(releaseConfig).toMatch(/exclude:\s*\[[\s\S]*"phase2-baseline\.test\.ts"[\s\S]*\]/);
    expect(baselineConfig).toContain('include: ["phase2-baseline.test.ts"]');
    expect(baselineConfig).toContain("fileParallelism: false");
    expect(baselineConfig).toContain("groupOrder: 4");
    expect(baselineConfig).toContain("testTimeout: 60_000");
    expect(manifest.scripts["test:coverage"]).toContain("--project=!phase2-baseline");
  });
});
