import { createHash } from "node:crypto";
import type { AgentConfig } from "coremind-config";
import type { StandardSkill } from "coremind-templates/internal";
import { describe, expect, it } from "vitest";
import type { AgentDriverObservation, AgentDriverToolResult } from "./agent-driver.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import type { RunStateRecord } from "./run-state.js";
import {
  freezeSkillSnapshot,
  rebuildSkillResult,
  renderSkillBody,
  renderSkillReference,
  restoreSkillSnapshot,
  SKILL_TOOL_NAME,
  SkillExecution,
  type SkillLoadFact,
  type SkillSelection,
  type SkillSnapshot,
  skillPrefixContents,
} from "./skill-runtime.js";

const timestamp = "2026-10-14T00:00:00.000Z";

function skill(id = "selected", body = "  原正文\r\n末行\n"): StandardSkill {
  return {
    id,
    name: "选中技能",
    description: "第一行\n第二行",
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

function fixture(body?: string) {
  const selected = skill("selected", body);
  const agents: Record<string, SkillSelection> = {
    main: { legacyContents: ["旧 README 原文\r\n"], standard: [selected] },
    worker: { legacyContents: [], standard: [skill("worker-only", "另一个 Agent 的正文")] },
  };
  const config: Record<string, AgentConfig> = {
    main: { skills: ["selected"] },
    worker: { skills: ["worker-only"] },
  };
  return { selected, agents, config, snapshot: freezeSkillSnapshot(agents)! };
}

function start(snapshot: unknown): RunStateRecord {
  return {
    version: 1,
    runId: "skill-run",
    sequence: 1,
    timestamp,
    kind: "start",
    payload: { skillSnapshot: snapshot },
  };
}

function loadFact(snapshot: SkillSnapshot, delivery: "body" | "reference" = "body"): SkillLoadFact {
  const selected = snapshot.agents.main!.standard[0]!;
  return {
    version: 1,
    id: selected.id,
    bodySha256: selected.bodySha256,
    snapshotSha256: snapshot.sha256,
    delivery,
  };
}

function loadRecord(fact: SkillLoadFact, agent = "main", stepId?: string): RunStateRecord {
  return {
    version: 1,
    runId: "skill-run",
    sequence: 2,
    timestamp,
    kind: "event",
    payload: {
      eventId: "trace-load",
      runId: "skill-run",
      sequence: 1,
      timestamp,
      event: {
        type: "tool_result",
        tool: SKILL_TOOL_NAME,
        agent,
        stepId,
        callId: "loaded",
        isError: false,
      },
      skillLoad: fact,
    },
  };
}

async function execute(
  execution: SkillExecution,
  callId: string,
  args: unknown = { id: "selected" },
  signal?: AbortSignal,
): Promise<AgentDriverToolResult> {
  return (await execution.tool.execute(
    callId,
    args as never,
    signal,
    undefined,
  )) as AgentDriverToolResult;
}

function ended(
  callId: string,
  result: AgentDriverToolResult,
): Extract<AgentDriverObservation, { type: "tool_execution_end" }> {
  return {
    type: "tool_execution_end",
    call: { callId, tool: SKILL_TOOL_NAME, args: { id: "selected" } },
    result,
    isError: false,
  };
}

function message(callId: string, result: AgentDriverToolResult) {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: SKILL_TOOL_NAME,
    isError: false,
    content: structuredClone(result.content),
  };
}

describe("标准技能冻结与结果重建", () => {
  it("只为含标准技能的 Run 冻结，并隔离输入与恢复副本", () => {
    expect(
      freezeSkillSnapshot({ main: { legacyContents: ["旧正文"], standard: [] } }),
    ).toBeUndefined();
    const { agents, config, selected, snapshot } = fixture();
    expect(snapshot.version).toBe(1);
    expect(selected.bodySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.sha256).toBe(fingerprintEffectReceiptValue({ version: 1, agents }));
    const records = [start(snapshot)];
    const restored = restoreSkillSnapshot(records, config)!;
    expect(restored).toEqual(snapshot);
    agents.main!.standard[0]!.body = "输入已变化";
    agents.main!.legacyContents.push("新增旧技能");
    expect(snapshot.agents.main!.standard[0]!.body).toBe("  原正文\r\n末行\n");
    snapshot.agents.main!.standard[0]!.body = "持久记录对象后来变化";
    expect(restored.agents.main!.standard[0]!.body).toBe("  原正文\r\n末行\n");
    expect(restored.agents.main!.legacyContents).toEqual(["旧 README 原文\r\n"]);
  });

  it.each(["", " \r\n\t"])("空白正文也能冻结后恢复，SHA 保留实际字节 %j", (body) => {
    const { config, snapshot } = fixture(body);
    expect(restoreSkillSnapshot([start(snapshot)], config)).toEqual(snapshot);
    expect(snapshot.agents.main!.standard[0]!.bodySha256).toBe(
      createHash("sha256").update(body, "utf8").digest("hex"),
    );
  });

  it("旧记录没有标准技能快照时不伪造新快照", () => {
    expect(restoreSkillSnapshot([], { main: {} })).toBeUndefined();
    const legacyStart = { ...start(undefined), payload: { configName: "legacy" } };
    expect(restoreSkillSnapshot([legacyStart], { main: {} })).toBeUndefined();
    const { snapshot, config } = fixture();
    expect(() =>
      restoreSkillSnapshot([legacyStart, loadRecord(loadFact(snapshot))], config),
    ).toThrow("原冻结快照缺失");
  });

  it.each(["body", "bodySha256", "duplicate", "unknown-id", "name", "version", "whole-sha"])(
    "恢复拒绝损坏快照 %s，字段回归不依赖旧整份校验和",
    (damage) => {
      const { config, snapshot } = fixture();
      const selected = snapshot.agents.main!.standard[0]!;
      if (damage === "body") selected.body += "漂移";
      if (damage === "bodySha256") selected.bodySha256 = `sha256:${selected.bodySha256}`;
      if (damage === "duplicate") snapshot.agents.main!.standard.push(structuredClone(selected));
      if (damage === "unknown-id") selected.id = "not-selected";
      if (damage === "name") selected.name = " ";
      if (damage === "version") (snapshot as { version: number }).version = 2;
      const { sha256: _sha256, ...value } = snapshot;
      snapshot.sha256 =
        damage === "whole-sha" ? "0".repeat(64) : fingerprintEffectReceiptValue(value);
      expect(() => restoreSkillSnapshot([start(snapshot)], config)).toThrow(
        "原技能快照损坏或选择不匹配",
      );
    },
  );

  it("Agent 集合和技能授权不匹配时失败关闭，内置 ID 不能冒充标准技能", () => {
    const { config, snapshot } = fixture();
    expect(() => restoreSkillSnapshot([start(snapshot)], { main: config.main! })).toThrow();
    expect(() =>
      restoreSkillSnapshot([start(snapshot)], { ...config, main: { skills: [] } }),
    ).toThrow();
    snapshot.agents.main!.standard[0]!.id = "code-review";
    const { sha256: _sha256, ...value } = snapshot;
    snapshot.sha256 = fingerprintEffectReceiptValue(value);
    expect(() =>
      restoreSkillSnapshot([start(snapshot)], { ...config, main: { skills: ["code-review"] } }),
    ).toThrow();
  });

  it("全部 Agent 的完整快照恰好 2 MiB 可恢复，超过一字节拒绝冻结和恢复", () => {
    const agents: Record<string, SkillSelection> = {};
    const config: Record<string, AgentConfig> = {};
    for (let index = 0; index < 9; index++) {
      const id = `skill-${index}`;
      agents[`agent-${index}`] = { legacyContents: [], standard: [skill(id, "x".repeat(230_000))] };
      config[`agent-${index}`] = { skills: [id] };
    }
    const initial = freezeSkillSnapshot(agents)!;
    const tail = agents["agent-8"]!.standard[0]!;
    tail.body += "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(initial), "utf8"));
    tail.bodySha256 = createHash("sha256").update(tail.body, "utf8").digest("hex");
    const exact = freezeSkillSnapshot(agents)!;
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(2 * 1024 * 1024);
    expect(restoreSkillSnapshot([start(exact)], config)).toEqual(exact);
    tail.body += "x";
    tail.bodySha256 = createHash("sha256").update(tail.body, "utf8").digest("hex");
    expect(() => freezeSkillSnapshot(agents)).toThrow("2 MiB");
    const oversizedValue = { version: 1 as const, agents };
    expect(() =>
      restoreSkillSnapshot(
        [start({ ...oversizedValue, sha256: fingerprintEffectReceiptValue(oversizedValue) })],
        config,
      ),
    ).toThrow("2 MiB");
  });

  it("初始索引不含未加载正文，正文、引用与离线重建逐字节相同", () => {
    const { agents, selected, snapshot } = fixture();
    expect(skillPrefixContents({ legacyContents: ["旧正文"], standard: [] })).toEqual(["旧正文"]);
    const prefix = skillPrefixContents(agents.main!);
    expect(prefix[0]).toBe("旧 README 原文\r\n");
    expect(prefix.join("\n")).toContain(selected.bodySha256);
    expect(prefix.join("\n")).not.toContain(selected.body);
    const body = `# 技能 selected · 选中技能\n正文 SHA-256: ${selected.bodySha256}\n\n  原正文\r\n末行\n`;
    const reference = `技能 selected 已在当前上下文中（SHA-256: ${selected.bodySha256}），请复用已加载正文。`;
    expect(renderSkillBody(selected)).toBe(body);
    expect(renderSkillReference(selected)).toBe(reference);
    for (const [delivery, text] of [
      ["body", body],
      ["reference", reference],
    ] as const) {
      expect(rebuildSkillResult(snapshot, "main", loadFact(snapshot, delivery))).toEqual({
        content: [{ type: "text", text }],
        details: { id: "selected", bodySha256: selected.bodySha256, delivery },
      });
    }
    expect(() => rebuildSkillResult(snapshot, "worker", loadFact(snapshot))).toThrow();
    expect(() =>
      rebuildSkillResult(snapshot, "main", { ...loadFact(snapshot), snapshotSha256: "wrong" }),
    ).toThrow();
  });
});

describe("技能执行只认可观察成功及实际正文驻留", () => {
  it("execute 本身不宣称加载成功；真实成功观察后重复引用，正文移出后同 SHA 重载", async () => {
    const { selected, snapshot } = fixture();
    const execution = new SkillExecution(snapshot, "main");
    expect(execution.tool.executionMode).toBe("sequential");
    const body = await execute(execution, "loaded");
    expect(await execute(execution, "not-yet-observed")).toEqual(body);
    const fact = execution.observe(ended("loaded", body));
    expect(fact).toEqual(loadFact(snapshot));
    const reference = await execute(execution, "reference");
    expect(reference).toEqual(
      rebuildSkillResult(snapshot, "main", loadFact(snapshot, "reference")),
    );
    expect(execution.observe(ended("reference", reference))?.delivery).toBe("reference");
    execution.refresh([message("loaded", body), message("reference", reference)]);
    expect((await execute(execution, "still-resident")).content).toEqual(reference.content);
    execution.refresh([message("reference", reference)]);
    const reloaded = await execute(execution, "reloaded");
    expect(reloaded).toEqual(body);
    expect(reloaded.details).toMatchObject({ bodySha256: selected.bodySha256, delivery: "body" });
    expect(execution.observe(ended("reloaded", reloaded))?.delivery).toBe("body");
    execution.refresh([message("reloaded", reloaded)]);
    expect((await execute(execution, "after-reload")).content).toEqual(reference.content);
  });

  it.each(["error", "content", "details", "tool", "id", "call"])(
    "%s 失败或伪造观察不形成正文驻留",
    async (damage) => {
      const { snapshot } = fixture();
      const execution = new SkillExecution(snapshot, "main");
      const result = await execute(execution, "loaded");
      const observation = ended("loaded", structuredClone(result));
      if (damage === "error") observation.isError = true;
      if (damage === "content") observation.result.content = [{ type: "text", text: "伪造正文" }];
      if (damage === "details")
        observation.result.details = { delivery: "body", bodySha256: "伪造" };
      if (damage === "tool") observation.call.tool = "lookalike";
      if (damage === "id") observation.call.args = { id: "worker-only" };
      if (damage === "call") observation.call.callId = "unknown";
      expect(execution.observe(observation)).toBeUndefined();
      expect(await execute(execution, "retry")).toEqual(result);
    },
  );

  it.each(["user", "assistant", "unknown-call", "wrong-tool", "error-result", "wrong-body"])(
    "%s 工作集内容不能冒充已驻留正文",
    async (source) => {
      const { snapshot } = fixture();
      const execution = new SkillExecution(snapshot, "main");
      const result = await execute(execution, "loaded");
      execution.observe(ended("loaded", result));
      const forged = message("loaded", result);
      if (source === "user" || source === "assistant") forged.role = source;
      if (source === "unknown-call") forged.toolCallId = "not-observed";
      if (source === "wrong-tool") forged.toolName = "lookalike";
      if (source === "error-result") forged.isError = true;
      if (source === "wrong-body") forged.content = [{ type: "text", text: "已加载 selected" }];
      execution.refresh([forged]);
      expect(await execute(execution, "retry")).toEqual(result);
    },
  );

  it.each([
    null,
    {},
    { id: "worker-only" },
    { id: "../selected" },
    { id: "selected", path: "secret" },
    { id: "selected", agent: "worker" },
  ])("真实工具拒绝未授权或额外参数 %j", async (args) => {
    const { snapshot } = fixture();
    const execution = new SkillExecution(snapshot, "main");
    expect(execution.tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: { id: { enum: ["selected"] } },
    });
    await expect(execute(execution, "denied", args)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("预先取消的加载不会产生可成功观察的候选正文", async () => {
    const { snapshot } = fixture();
    const execution = new SkillExecution(snapshot, "main");
    const controller = new AbortController();
    controller.abort("取消读取");
    await expect(
      execute(execution, "cancelled", { id: "selected" }, controller.signal),
    ).rejects.toBeDefined();
    const expected = rebuildSkillResult(snapshot, "main", loadFact(snapshot));
    expect(execution.observe(ended("cancelled", expected))).toBeUndefined();
    expect(await execute(execution, "retry")).toEqual(expected);
  });

  it("恢复只有加载事实仍返回正文；匹配 callId 的实际正文进入工作集后才返回引用", async () => {
    const { snapshot } = fixture();
    const fact = loadFact(snapshot);
    const records = [start(snapshot), loadRecord(fact, "main", "step-1")];
    const execution = new SkillExecution(snapshot, "main", records, "step-1");
    const body = rebuildSkillResult(snapshot, "main", fact);
    expect(await execute(execution, "without-messages")).toEqual(body);
    execution.refresh([message("another-call", body)]);
    expect(await execute(execution, "wrong-message")).toEqual(body);
    execution.refresh([message("loaded", body)]);
    expect(await execute(execution, "resident")).toEqual(
      rebuildSkillResult(snapshot, "main", loadFact(snapshot, "reference")),
    );
  });

  it.each(["other-agent", "other-step", "reference"])(
    "恢复隔离 %s 的历史事实，不能因此驻留正文",
    async (source) => {
      const { agents } = fixture();
      if (source === "other-agent") {
        // 两个 Agent 都合法选中相同正文，仍不能借另一个 Agent 的 callId 宣称本次已加载。
        agents.worker!.standard = [structuredClone(agents.main!.standard[0]!)];
      }
      const snapshot = freezeSkillSnapshot(agents)!;
      const fact = loadFact(snapshot, source === "reference" ? "reference" : "body");
      const record = loadRecord(
        fact,
        source === "other-agent" ? "worker" : "main",
        source === "other-step" ? "step-2" : "step-1",
      );
      const execution = new SkillExecution(snapshot, "main", [record], "step-1");
      const body = rebuildSkillResult(snapshot, "main", loadFact(snapshot));
      execution.refresh([message("loaded", body)]);
      expect(await execute(execution, "new-load")).toEqual(body);
    },
  );

  it("匹配本 Agent/步骤的损坏加载事实不能静默恢复", () => {
    const { snapshot } = fixture();
    const record = loadRecord({ ...loadFact(snapshot), bodySha256: "wrong" }, "main", "step-1");
    expect(() => new SkillExecution(snapshot, "main", [record], "step-1")).toThrow(
      "技能加载事实与原快照不匹配",
    );
    const failed = loadRecord(loadFact(snapshot), "main", "step-1");
    (failed.payload as { event: { isError: boolean } }).event.isError = true;
    expect(() => new SkillExecution(snapshot, "main", [failed], "step-1")).toThrow("调用身份损坏");
  });
});
