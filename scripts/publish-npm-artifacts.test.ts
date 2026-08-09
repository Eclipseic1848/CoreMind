import { describe, expect, it } from "vitest";
import { createNpmPublishPlan } from "./publish-npm-artifacts.mjs";

describe("npm 发布顺序", () => {
  it("按依赖顺序发布八个公开包并沿用清单 dist-tag", () => {
    const names = [
      "coremind-cli",
      "coremind-worker",
      "coremind-ai",
      "coremind-runtime",
      "coremind-templates",
      "coremind-tools",
      "coremind-protocol",
      "coremind-config",
    ];
    const plan = createNpmPublishPlan({
      version: "0.2.0-rc.1",
      npmDistTag: "next",
      artifacts: names.map((name) => ({
        kind: "npm",
        name,
        version: "0.2.0-rc.1",
        path: `npm/${name}.tgz`,
      })),
    });

    expect(plan.map((item) => item.name)).toEqual([
      "coremind-config",
      "coremind-protocol",
      "coremind-tools",
      "coremind-templates",
      "coremind-runtime",
      "coremind-ai",
      "coremind-worker",
      "coremind-cli",
    ]);
    expect(plan.every((item) => item.distTag === "next")).toBe(true);
  });

  it("缺包、重复包或版本漂移都会阻止发布", () => {
    expect(() =>
      createNpmPublishPlan({ version: "0.2.0", npmDistTag: "latest", artifacts: [] }),
    ).toThrow("缺少 npm 发布物");
    expect(() =>
      createNpmPublishPlan({
        version: "0.2.0",
        npmDistTag: "latest",
        artifacts: [
          { kind: "npm", name: "coremind-config", version: "0.1.0", path: "a.tgz" },
          { kind: "npm", name: "coremind-config", version: "0.2.0", path: "b.tgz" },
        ],
      }),
    ).toThrow();
  });
});
