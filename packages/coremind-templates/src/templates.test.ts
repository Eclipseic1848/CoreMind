import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

    it(`[${t.id}] 包内模板使用已认证入口且不把 Provider 凭据写成业务依赖`, () => {
      expect(config.provider).toMatchObject({
        id: "alibaba-model-studio",
        apiKeyEnv: "DASHSCOPE_API_KEY",
      });
      expect(t.requiresEnv).not.toContain(config.provider?.apiKeyEnv);
    });
  }

  it("document-assistant 只向 Agent 开放两项资料查询，默认由宿主审批文件写入", () => {
    const config = parsed.get("document-assistant")!;
    const template = TEMPLATES.find((t) => t.id === "document-assistant")!;
    expect(template.requiresEnv).toEqual([
      "COREMIND_KNOWLEDGE_AUTHORIZATION",
      "COREMIND_MEMORY_AUTHORIZATION",
    ]);
    expect(Object.keys(config.mcp!.servers)).toEqual(["knowledge", "memory"]);
    for (const [name, server] of Object.entries(config.mcp!.servers)) {
      expect(server).toMatchObject({
        allowedAddresses: ["127.0.0.1"],
        headers: { Authorization: { env: `COREMIND_${name.toUpperCase()}_AUTHORIZATION` } },
      });
    }
    const agent = config.agents.main!;
    expect(
      agent.tools?.map((tool) => ("mcp" in tool ? tool.mcp.tool : "id" in tool && tool.id)),
    ).toEqual(["write", "search_knowledge", "recall_memory"]);
    for (const tool of agent.tools ?? []) {
      if ("mcp" in tool) {
        expect(tool.capability).toMatchObject({
          effect: "network",
          durability: "critical",
          concurrency: "run_serial",
        });
      }
    }
    expect(agent.skills).toEqual(["document-comparison"]);
    expect(existsSync(path.join(template.dir, "skills/document-comparison/SKILL.md"))).toBe(true);
    expect(config.permissions).toMatchObject({
      mode: "ask",
      workspaceOnly: true,
      allow: ["load_skill"],
    });
  });

  it("启用后保留普通配置，只增加本体只读动作检查", () => {
    const template = TEMPLATES.find((t) => t.id === "document-assistant")!;
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-ontology-config-"));
    try {
      const ordinary = path.join(dir, "coremind.yaml");
      const target = path.join(dir, "coremind-ontology.yaml");
      copyFileSync(path.join(template.dir, "coremind.yaml"), ordinary);
      const original = readFileSync(ordinary, "utf8");
      execFileSync(process.execPath, [path.join(template.dir, "enable-ontology.mjs")], {
        cwd: dir,
      });
      const withOntology = validateConfig(parseConfigText(readFileSync(target, "utf8")));
      expect(withOntology.provider).toEqual(parsed.get("document-assistant")!.provider);
      expect(withOntology.mcp!.servers.ontology).toMatchObject({
        url: "http://127.0.0.1:8879/mcp",
        headers: { Authorization: { env: "COREMIND_ONTOLOGY_AUTHORIZATION" } },
      });
      expect(withOntology.agents.main!.tools!.slice(0, -1)).toEqual(
        parsed.get("document-assistant")!.agents.main!.tools,
      );
      expect(withOntology.agents.main!.tools!.at(-1)).toMatchObject({
        mcp: { server: "ontology", tool: "ontology_inspect_action" },
        capability: { effect: "network", durability: "critical", concurrency: "run_serial" },
      });
      expect(readFileSync(ordinary, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blog-writer 一次生成并一次写入，不提供无关命令工具", () => {
    const config = parsed.get("blog-writer")!;
    expect(config.workflow).toHaveLength(1);
    expect(
      config.agents.writer?.tools?.map((tool) => ("id" in tool ? tool.id : undefined)),
    ).toEqual(["write"]);
    expect(config.agents.writer?.systemPrompt).toContain("不得虚构");
    expect(JSON.stringify(config.workflow)).toContain("只调用一次 write");
  });
});
