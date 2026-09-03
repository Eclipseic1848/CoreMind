import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(
      workflow.jobs.deploy.steps.map((step: { run?: string }) => step.run).join("\n"),
    ).toContain("npm install --global npm@11.5.1");
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
    expect(commands).toContain("npm install --global npm@11.5.1");
    expect(commands).toContain("npm run typecheck");
    expect(commands).toContain("npm run security:audit");
    expect(commands).toContain("npm run check:docs");
    expect(commands).toContain("npm run test:engineering");
    expect(
      workflow.jobs.engineering.steps.find(
        (step: { name?: string }) => step.name === "核心确定性测试",
      ).run,
    ).toBe("npm run test:engineering -- --maxWorkers=1");
    expect(commands).toContain("python -W error::ResourceWarning -m unittest discover");
    expect(commands).toContain("COREMIND_JOB_STARTED_EPOCH");
    expect(commands).toContain("GITHUB_STEP_SUMMARY");
    expect(commands.indexOf("npm run build")).toBeLessThan(commands.indexOf("npm run typecheck"));
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
    expect(candidateCommands).toContain("npm install --global npm@11.5.1");
    for (const input of [
      "provider",
      "model",
      "credential_env",
      "max_cost_usd",
      "max_duration_minutes",
      "expected_version",
      "expected_commit",
      "expected_runtime_sha256",
    ]) {
      expect(workflow.on.workflow_dispatch.inputs[input].required).toBe(true);
    }
    expect(workflow.jobs.candidate.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    for (const command of [
      "npm run test:stability",
      "npm run test:coverage",
      "npm run acceptance:tty",
      "npm run release:check-npm",
      "npm run release:test-npm",
      "npm run release:test-source",
      "npm run acceptance:rc -- --defer-provider-certification",
      "npm run candidate:bundle",
    ]) {
      expect(candidateCommands).toContain(command);
    }
    const candidateUpload = workflow.jobs.candidate.steps.find(
      (step: { name?: string }) => step.name === "保存候选产物与 SHA-256 清单",
    );
    expect(candidateUpload.uses).toContain("actions/upload-artifact@");
    expect(candidateUpload.with.path).toContain(".scratch/candidate-artifacts");
    for (const name of [
      "完整工程与发布前置门禁",
      "安装并测试 Python SDK（离线）",
      "构建并检查 PyPI wheel",
    ]) {
      expect(
        workflow.jobs.candidate.steps.find((step: { name?: string }) => step.name === name).shell,
      ).toBe("bash");
    }
    expect(candidateCommands).toContain("COREMIND_JOB_STARTED_EPOCH");
    expect(candidateCommands).toContain("GITHUB_STEP_SUMMARY");
    expect(candidateCommands.indexOf("npm run build")).toBeLessThan(
      candidateCommands.indexOf("npm run typecheck"),
    );
    expect(candidateCommands).not.toContain("npm run providers:certify");
    expect(workflow.jobs["provider-certification"].if).toContain("workflow_dispatch");
    expect(workflow.jobs["provider-certification"].if).toContain("strict-provider");
    expect(workflow.jobs["provider-certification"].if).toContain("refs/heads/main");
    expect(workflow.jobs["provider-certification"].if).toContain("inputs.expected_commit");
    expect(workflow.jobs["provider-certification"].if).toContain(
      "inputs.credential_env == 'COREMIND_CERT_API_KEY'",
    );
    expect(workflow.jobs["provider-certification"]["timeout-minutes"]).toContain(
      "inputs.max_duration_minutes",
    );
    const candidateSandboxSetup = workflow.jobs.candidate.steps.find(
      (step: { name?: string }) => step.name === "安装 Linux sandbox 依赖",
    );
    const providerSandboxSetup = workflow.jobs["provider-certification"].steps.find(
      (step: { name?: string }) => step.name === "安装 Linux sandbox 依赖",
    );
    expect(providerSandboxSetup?.run).toBe(candidateSandboxSetup?.run);
    expect(workflow.jobs["provider-certification"].env).toMatchObject({
      COREMIND_CERT_API_KEY_ENV: `\${{ inputs.credential_env }}`,
      COREMIND_CERT_MAX_COST_USD: `\${{ inputs.max_cost_usd }}`,
      COREMIND_CERT_MAX_DURATION_MINUTES: `\${{ inputs.max_duration_minutes }}`,
      COREMIND_CERT_EXPECTED_VERSION: `\${{ inputs.expected_version }}`,
      COREMIND_CERT_EXPECTED_COMMIT: `\${{ inputs.expected_commit }}`,
      COREMIND_CERT_EXPECTED_RUNTIME_SHA256: `\${{ inputs.expected_runtime_sha256 }}`,
    });
    const candidateDownload = workflow.jobs["provider-certification"].steps.find(
      (step: { name?: string }) => step.name === "下载同次 Linux 候选制品",
    );
    expect(candidateDownload.uses).toContain("actions/download-artifact@");
    expect(candidateDownload.with.name).toContain("candidate-artifacts-Linux-");
    expect(providerCommands).toContain("npm run providers:certify");
    expect(providerCommands).toContain("npm run providers:matrix");
    expect(providerCommands.indexOf("npm run providers:certify")).toBeLessThan(
      providerCommands.indexOf("npm run providers:matrix"),
    );
    expect(providerCommands.indexOf("npm run providers:matrix")).toBeLessThan(
      providerCommands.indexOf("npm run release:preflight -- --allow-dirty"),
    );
    expect(providerCommands).toContain("npm run release:preflight -- --allow-dirty");
    expect(providerCommands).not.toContain("--defer-provider-certification");
    const evidenceUpload = workflow.jobs["provider-certification"].steps.find(
      (step: { name?: string }) => step.name === "保存 Provider 认证证据",
    );
    expect(evidenceUpload.uses).toContain("actions/upload-artifact@");
    expect(evidenceUpload.with.path).toContain("docs/providers/evidence/*.json");
    expect(evidenceUpload.with.path).toContain("docs/providers/certifications.json");
    expect(providerCommands).toContain("COREMIND_JOB_STARTED_EPOCH");
    expect(providerCommands).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow.jobs.qualified.name).toBe("Candidate qualified");
    expect(workflow.jobs.qualified.if).toContain("strict-provider");
    const qualifiedCommands = workflow.jobs.qualified.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(qualifiedCommands).toContain("GITHUB_RUN_ID");
    expect(qualifiedCommands).toContain("GITHUB_STEP_SUMMARY");
  });

  it("快速测试显式列出工程项目，候选三连跑仍覆盖完整 npm test", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const engineeringConfig = readFileSync("vitest.engineering.config.ts", "utf8");

    expect(manifest.scripts.test).toBe("vitest run");
    expect(manifest.scripts["test:stability"]).toContain("scripts/test-stability.mjs");
    expect(manifest.scripts["test:engineering"]).toContain("vitest.engineering.config.ts");
    expect(engineeringConfig).toContain('"packages/*"');
    expect(engineeringConfig).toContain("vitest.input-receipt-engineering.config.ts");
    expect(engineeringConfig).toContain("vitest.host-shell.config.ts");
    expect(engineeringConfig).toContain("examples/coding-evals/vitest.config.ts");
    expect(engineeringConfig).toContain("scripts/vitest.config.ts");
    expect(engineeringConfig).not.toContain("trusted-tool-fault-matrix");
    expect(engineeringConfig).not.toContain("phase2-baseline");
  });

  it("候选稳定性三连按段执行，任一段失败立即停止", () => {
    const directory = mkdtempSync(join(tmpdir(), "coremind-stability-contract-"));
    const callsPath = join(directory, "calls.txt");
    const npmCliPath = join(directory, "npm-cli.mjs");
    const latency = "isolated-input-receipt-acceptance";
    const faultMatrix = "isolated-trusted-tool-fault-matrix";
    const remaining = "!isolated-*";
    writeFileSync(
      npmCliPath,
      `import { appendFileSync } from "node:fs";
const projects = process.argv.filter((value) => value.startsWith("--project=")).map((value) => value.slice(10));
const selector = projects.join(",");
const maxWorkers = process.argv.find((value) => value.startsWith("--maxWorkers="))?.slice(13) ?? "default";
appendFileSync(process.env.COREMIND_TEST_CALLS, process.env.COREMIND_STABILITY_RUN + ":" + selector + ":" + maxWorkers + "\\n", "utf8");
if (selector === process.env.COREMIND_TEST_FAIL_SELECTOR) process.exitCode = 1;
`,
      "utf8",
    );

    const run = (failSelector = "") => {
      writeFileSync(callsPath, "", "utf8");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_execpath"),
      );
      const result = spawnSync(process.execPath, ["scripts/test-stability.mjs"], {
        encoding: "utf8",
        env: {
          ...env,
          COREMIND_TEST_CALLS: callsPath,
          COREMIND_TEST_FAIL_SELECTOR: failSelector,
          npm_execpath: npmCliPath,
        },
      });
      const calls = readFileSync(callsPath, "utf8").trim().split("\n");
      return { calls, status: result.status };
    };

    try {
      expect(run()).toEqual({
        calls: [1, 2, 3].flatMap((iteration) => [
          `${iteration}:${latency}:default`,
          `${iteration}:${faultMatrix}:default`,
          `${iteration}:${remaining}:1`,
        ]),
        status: 0,
      });
      expect(run(latency)).toEqual({ calls: [`1:${latency}:default`], status: 1 });
      expect(run(faultMatrix)).toEqual({
        calls: [`1:${latency}:default`, `1:${faultMatrix}:default`],
        status: 1,
      });
      expect(run(remaining)).toEqual({
        calls: [`1:${latency}:default`, `1:${faultMatrix}:default`, `1:${remaining}:1`],
        status: 1,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("候选其余项目选择器不会重新包含两个隔离项目", () => {
    const result = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "list", "--project=!isolated-*", "--filesOnly"],
      { encoding: "utf8", timeout: 25_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("race-matrix.acceptance.test.ts");
    expect(result.stdout).not.toContain("input-receipt.acceptance.test.ts");
    expect(result.stdout).not.toContain("trusted-tool-fault-matrix.test.ts");
  }, 30_000);

  it("工程门与候选门并集保留拆分前的全部门禁命令", () => {
    const engineering = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const candidate = parse(readFileSync(".github/workflows/candidate-qualification.yml", "utf8"));
    const commands = [
      ...engineering.jobs.engineering.steps,
      ...candidate.jobs.candidate.steps,
      ...candidate.jobs["provider-certification"].steps,
    ]
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    const preservedGateCommands = [
      "npx biome check .",
      "npm run security:audit",
      "npm run build",
      "npm run acceptance:workspace-lease",
      "npm run baseline:check",
      "npm run dependencies:check",
      "npm run check:modules",
      "npm run check:docs",
      "npm run docs:build",
      "npm run providers:matrix",
      "npm run test:stability",
      "npm run test:coverage",
      "npm run build:python-worker",
      "python -W error::ResourceWarning -m unittest discover",
      "python -m build --wheel python",
      "python -m twine check python/dist/*",
      "npm run release:check-wheel",
      "node --input-type=module -e",
      "npm run acceptance:tty",
      "npm run release:preflight",
      "npm run release:check-npm",
      "npm run release:test-npm",
      "npm run release:test-source",
      "npm run acceptance:rc",
    ];

    for (const command of preservedGateCommands) expect(commands).toContain(command);
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
    expect(workflow.on.workflow_dispatch.inputs.artifact_run_id.required).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.artifact_run_id.default).toBe("");
    expect(workflow.concurrency.group).toContain("inputs.tag");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
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
    expect(workflow.jobs.release.outputs.public_release_ready).toContain(
      "steps.public-release.outputs.ready",
    );
    const publicReleaseStep = workflow.jobs.release.steps.find(
      (step: { id?: string }) => step.id === "public-release",
    );
    expect(publicReleaseStep.run).toContain("ready=true");
    const releaseEvidenceStep = workflow.jobs.release.steps.find(
      (step: { name?: string }) => step.name === "保存 P0 发布报告",
    );
    expect(releaseEvidenceStep.if).toContain("always()");
    const releaseCommands = workflow.jobs.release.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(releaseCommands).toContain("gh workflow run docs.yml --ref main");
    expect(releaseCommands).toContain("p0-acceptance.mjs --stage release");
    expect(releaseCommands).toContain("--verified-workflow-run");
    expect(releaseCommands).toContain("cmp --silent");
    expect(releaseCommands).toContain("release_status");
    expect(releaseCommands).toContain("GitHub Release 状态未知；停止发布");
    expect(releaseCommands).toContain("expected_prerelease");
    expect(releaseCommands).toContain("GitHub Release 包含未验证资产");
    expect(releaseCommands).not.toContain("--clobber");
    expect(workflow.jobs.build.needs).toBe("candidate");
    expect(workflow.jobs.build.permissions.actions).toBe("read");
    expect(
      workflow.jobs.build.steps.find((step: { name?: string }) => step.name === "安装 Node").with[
        "node-version"
      ],
    ).toBe("22");
    const resumeStep = workflow.jobs.build.steps.find(
      (step: { name?: string }) => step.name === "恢复既有已验证发布物",
    );
    expect(resumeStep.if).toContain("artifact_run_id != ''");
    expect(resumeStep.run).toContain("actions/runs/");
    expect(resumeStep.run).toContain("COREMIND_SOURCE_RUN_ID");
    expect(resumeStep.run).toContain("coremind-release-bundle");
    expect(resumeStep.run).toContain("sha256sum --check SHA256SUMS.txt");
    expect(resumeStep.run).toContain("Build release bundle");
    expect(resumeStep.run).toContain("filter=all&per_page=100");
    const freshBuildStep = workflow.jobs.build.steps.find(
      (step: { name?: string }) => step.name === "构建并验证同提交发布物",
    );
    expect(freshBuildStep.if).toContain("artifact_run_id == ''");
    expect(freshBuildStep.run).toContain("COREMIND_REUSED_CANDIDATE_RUN_ID");
    expect(freshBuildStep.env.COREMIND_SKIP_RELEASE_CHILD_RUN_SMOKE).toContain(
      "reuse_candidate_run_id",
    );
    const freshStateStep = workflow.jobs.build.steps.find(
      (step: { name?: string }) => step.name === "拒绝在未知或部分发布状态下重新构建",
    );
    expect(freshStateStep.if).toContain("artifact_run_id == ''");
    expect(freshStateStep.run).toContain("publish-pypi.yml/runs");
    expect(freshStateStep.run).toContain("--paginate");
    expect(freshStateStep.run).not.toContain("status=completed");
    expect(freshStateStep.run).toContain("GITHUB_RUN_ATTEMPT");
    expect(freshStateStep.run).toContain("filter=all&per_page=100");
    expect(freshStateStep.run).toContain("既有发布 run 状态未知；拒绝重新构建");
    expect(freshStateStep.run).toContain("registry.npmjs.org");
    expect(freshStateStep.run).toContain("pypi.org/pypi/coremind-ai");
    expect(freshStateStep.run).toContain(`"\${GH_TOKEN}"`);
    expect(freshStateStep.run).toContain("状态未知；拒绝重新构建");
    const candidateCommands = workflow.jobs.candidate.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(workflow.on.workflow_dispatch.inputs.reuse_candidate_run_id.default).toBe("");
    expect(candidateCommands).toContain("reuse_candidate_run_id 必须是 GitHub Actions run ID");
    expect(candidateCommands).toContain("git diff --name-only");
    expect(candidateCommands).toContain(
      "docs/release/evidence/v0\\.7\\.0-provider-network-waiver\\.json",
    );
    expect(candidateCommands).toContain("scripts/check-python-wheel\\.py");
    expect(candidateCommands).toContain("scripts/release-artifacts\\.mjs");
    expect(candidateCommands).toContain("scripts/validate-npm-tarballs\\.mjs");
    expect(candidateCommands).toContain("复用候选后存在产品代码改动");
    expect(candidateCommands).toContain("git fetch origin main --no-tags");
    expect(candidateCommands).toContain("git rev-parse FETCH_HEAD");
    expect(candidateCommands).toContain(`rulesets/\${ruleset_id}`);
    expect(candidateCommands).toContain("required_approving_review_count");
    expect(candidateCommands).toContain("integration_id");
    expect(candidateCommands).toContain("v0.7.0-main-ruleset.json");
    expect(candidateCommands).toContain("COREMIND_POLICY_SNAPSHOT_SHA256");
    expect(candidateCommands).not.toContain(`\${{ inputs.tag }}`);
    expect(candidateCommands).toContain("strict_required_status_checks_policy");
    expect(candidateCommands).toContain("COREMIND_REPOSITORY_RULESET_ID");
    expect(candidateCommands).toContain("actions/workflows/ci.yml/runs");
    expect(candidateCommands).toContain("actions/workflows/candidate-qualification.yml/runs");
    expect(candidateCommands).toContain("Candidate qualified");
    expect(candidateCommands).toContain("provider-certification-*");
    expect(candidateCommands).toContain("verify-provider-certification-artifact.mjs");
    expect(candidateCommands).toContain("--verify-manual-only");
    expect(candidateCommands).toContain("p0-acceptance.mjs --stage candidate");
    expect(candidateCommands).toContain("--verified-workflow-run");
    expect(candidateCommands).toContain("v0.7.0-provider-network-waiver.json");
    expect(candidateCommands).toContain("33582995518");
    const waiver = JSON.parse(
      readFileSync("docs/release/evidence/v0.7.0-provider-network-waiver.json", "utf8"),
    );
    expect(candidateCommands).toContain(waiver.decisionRef);
    expect(candidateCommands).toContain(waiver.candidateRuntimePackageSha256);
    expect(candidateCommands).toContain(waiver.finalDecisionRef);
    expect(candidateCommands).toContain(waiver.finalRuntimePackageSha256);
    expect(candidateCommands).toContain('Provider certification" and .conclusion == "skipped');
    expect(candidateCommands).toContain('Candidate qualified" and .conclusion == "skipped');
    expect(candidateCommands).not.toContain(".inputs.qualification_mode");
    expect(candidateCommands).not.toContain("release-preflight.mjs");
    expect(buildCommands).toContain(
      `if [ "\${COREMIND_PROVIDER_EVIDENCE_MODE}" = "provider-network-waiver" ]`,
    );
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
    const publicCommands = workflow.jobs["verify-public"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(workflow.jobs["verify-public"].needs).toEqual(
      expect.arrayContaining(["candidate", "release"]),
    );
    expect(workflow.jobs["verify-public"].if).toContain("always()");
    expect(workflow.jobs["verify-public"].if).toContain("needs.candidate.result == 'success'");
    expect(workflow.jobs["verify-public"].if).toContain(
      "needs.release.outputs.public_release_ready == 'true'",
    );
    expect(workflow.jobs["verify-public"].if).not.toContain("reuse_candidate_run_id");
    expect(publicCommands).toContain("npm pack");
    expect(publicCommands).toContain("validate-npm-tarballs.mjs --directory");
    expect(publicCommands).toContain("pip download");
    expect(publicCommands).toContain("check-python-wheel.py");
    expect(readFileSync("scripts/check-python-wheel.py", "utf8")).toContain(
      "COREMIND_SKIP_RELEASE_CHILD_RUN_SMOKE",
    );
    expect(publicCommands).not.toContain("coremind_ai-0.7.0-py3-none-any.whl");
    expect(publicCommands).toContain("p0-acceptance.mjs --stage post-release");
    for (const jobName of ["candidate", "release", "verify-public"]) {
      const p0Steps = workflow.jobs[jobName].steps.filter((step: { name?: string }) =>
        step.name?.startsWith("形成 P0"),
      );
      expect(p0Steps.every((step: { if?: string }) => step.if?.includes("v0.7.0"))).toBe(true);
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
      "examples/golden/vitest.config.ts",
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
    const faultMatrixTest = readFileSync("scripts/trusted-tool-fault-matrix.test.ts", "utf8");
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
    expect(faultMatrixConfig).toContain("testTimeout: 1_200_000");
    expect(faultMatrixTest).not.toContain("}, 900_000);");
    expect(inputReceiptConfig).toContain("groupOrder: 3");
  });

  it("快速工程门排除候选级重型矩阵与严格时延门，完整门仍保留", () => {
    const rootConfig = readFileSync("vitest.config.ts", "utf8");
    const engineeringConfig = readFileSync("vitest.engineering.config.ts", "utf8");
    const runtimeConfig = readFileSync("packages/coremind-runtime/vitest.config.ts", "utf8");
    const raceMatrixConfig = readFileSync(
      "packages/coremind-runtime/vitest.race-matrix.config.ts",
      "utf8",
    );
    const engineeringReceiptConfig = readFileSync(
      "packages/coremind-runtime/vitest.input-receipt-engineering.config.ts",
      "utf8",
    );

    expect(rootConfig).toContain("packages/coremind-runtime/vitest.race-matrix.config.ts");
    expect(engineeringConfig).not.toContain("vitest.race-matrix.config.ts");
    expect(runtimeConfig).toContain("src/race-matrix.acceptance.test.ts");
    expect(raceMatrixConfig).toContain('include: ["src/race-matrix.acceptance.test.ts"]');
    expect(engineeringConfig).toContain(
      "packages/coremind-runtime/vitest.input-receipt-engineering.config.ts",
    );
    expect(engineeringReceiptConfig).toContain("testNamePattern");
    expect(engineeringReceiptConfig).toContain("Cancel → Quiescent p95");
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
