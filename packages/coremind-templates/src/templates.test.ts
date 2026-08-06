import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type CoreMindConfig, parseConfigText, validateConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./index.js";

describe("模板元数据完整性", () => {
  it("四个分类各至少一个模板", () => {
    for (const category of ["general", "coding", "industry", "workflow"]) {
      expect(TEMPLATES.filter((t) => t.category === category).length).toBeGreaterThan(0);
    }
  });

  it("模板目录都存在且含 coremind.yaml", () => {
    for (const t of TEMPLATES) {
      expect(existsSync(t.dir), `${t.id} 目录缺失`).toBe(true);
      expect(existsSync(path.join(t.dir, "coremind.yaml")), `${t.id} 缺 coremind.yaml`).toBe(true);
    }
  });

  it("模板 id 唯一", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("模板配置合法", () => {
  const parsed = new Map<string, CoreMindConfig>();

  for (const t of TEMPLATES) {
    const yamlPath = path.join(t.dir, "coremind.yaml");
    const raw = readFileSync(yamlPath, "utf8");
    const config = validateConfig(parseConfigText(raw, yamlPath));
    parsed.set(t.id, config);

    it(`[${t.id}] 通过 schema 校验且 name 与 id 一致`, () => {
      expect(config.name).toBe(t.id);
      expect(config.agents).toBeDefined();
      expect(Object.keys(config.agents).length).toBeGreaterThan(0);
    });

    it(`[${t.id}] 引用的 agent 都已在 agents 中定义`, () => {
      const workflow = config.workflow ?? [];
      const agentNames = Object.keys(config.agents);
      const walk = (
        steps: {
          type: string;
          agent?: string;
          steps?: unknown[];
          then?: unknown[];
          else?: unknown[];
          cases?: Record<string, unknown[]>;
          default?: unknown[];
        }[],
      ): void => {
        for (const step of steps) {
          if (step.type === "prompt" || step.type === "call") {
            expect(agentNames, `[${t.id}] 步骤引用了未定义的 agent: ${step.agent}`).toContain(
              step.agent,
            );
          }
          if (step.steps) walk(step.steps as never[] as never);
          if (step.then) walk(step.then as never[] as never);
          if (step.else) walk(step.else as never[] as never);
          if (step.cases)
            for (const branch of Object.values(step.cases)) walk(branch as never[] as never);
          if (step.default) walk(step.default as never[] as never);
        }
      };
      walk(workflow as never[] as never);
    });

    it(`[${t.id}] requiresEnv 与实际配置的 provider 一致`, () => {
      // 内置 deepseek 需要 DEEPSEEK_API_KEY
      const provider = config.provider;
      const isBuiltin = !("baseUrl" in (provider ?? {}));
      if (isBuiltin) {
        expect(t.requiresEnv).toContain("DEEPSEEK_API_KEY");
      }
    });
  }
});
