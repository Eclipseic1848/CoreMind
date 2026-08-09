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

  it("双平台 CI 使用三连跑、覆盖率和真实发布物门禁", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const commands = workflow.jobs.test.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");

    expect(workflow.jobs.test.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(commands).toContain("npm run test:stability");
    expect(commands).toContain("npm run test:coverage");
    expect(commands).toContain("npm run release:check-npm");
    expect(commands).toContain("npm run release:test-npm");
    expect(commands).toContain("npm run release:test-source");
    expect(commands).toContain("npm run acceptance:rc");
  });

  it("Release Please 只创建草稿版本 PR，不自动打标签或发布", () => {
    const workflow = parse(readFileSync(".github/workflows/release-please.yml", "utf8"));
    const config = JSON.parse(readFileSync("release-please-config.json", "utf8"));
    const manifest = JSON.parse(readFileSync(".release-please-manifest.json", "utf8"));
    const step = workflow.jobs.release.steps.find((item: { uses?: string }) =>
      item.uses?.startsWith("googleapis/release-please-action@"),
    );

    expect(workflow.on.workflow_dispatch.inputs.release_as.required).toBe(true);
    expect(workflow.permissions.contents).toBe("write");
    expect(workflow.permissions["pull-requests"]).toBe("write");
    expect(step.uses).toMatch(/^googleapis\/release-please-action@[0-9a-f]{40}$/u);
    expect(step.with["release-as"]).toContain("release_as");
    expect(config["draft-pull-request"]).toBe(true);
    expect(config["skip-github-release"]).toBe(true);
    expect(config.packages["."]["changelog-path"]).toBe("CHANGELOG.en.md");
    expect(manifest["."]).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("统一发布工作流一次构建并分别通过受保护环境发布 npm 与 PyPI", () => {
    const workflow = parse(readFileSync(".github/workflows/publish-pypi.yml", "utf8"));
    const serialized = JSON.stringify(workflow);

    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(
      workflow.jobs.build.steps.some((step: { run?: string }) =>
        step.run?.includes("npm run release:bundle"),
      ),
    ).toBe(true);
    expect(workflow.jobs.npm.environment.name).toBe("npm");
    expect(workflow.jobs.npm.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.npm.needs).toContain("build");
    expect(workflow.jobs.pypi.environment.name).toBe("pypi");
    expect(workflow.jobs.pypi.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.pypi.needs).toContain("build");
    expect(workflow.jobs.attest.permissions.attestations).toBe("write");
    expect(workflow.jobs.attest.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.release.needs).toEqual(expect.arrayContaining(["npm", "pypi", "attest"]));
    expect(serialized).not.toContain("NODE_AUTH_TOKEN");
    expect(serialized).toContain("npm@11.5.1");
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
});
