import "../../../test/setup-env.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, vi } from "vitest";
import type { ControlReceipt } from "./control-inbox.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import type { CoreMindEvent } from "./events.js";
import { rebuildRunRequest } from "./rebuild-request.js";
import {
  FileRunStore,
  type RunStateRecord,
  type RunStoreDurability,
  type RunStoreDurabilityAcknowledgement,
} from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";
import {
  rebuildSkillResult,
  restoreSkillSnapshot,
  type SkillLoadFact,
  type SkillSnapshot,
  skillPrefixContents,
} from "./skill-runtime.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

const skillId = "frozen-runtime-skill";
const skillName = "冻结技能";
const description = "以原正文完成恢复和委派";
const body = "原始冻结正文，只允许读取这一版：中文🙂。\n末尾换行必须保留。\n";
const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
const renderedBody = `# 技能 ${skillId} · ${skillName}\n正文 SHA-256: ${bodySha256}\n\n${body}`;
const frontmatter = `---\nname: ${skillName}\ndescription: ${description}\n---\n`;

interface WireRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

describe("标准技能的真实持久化与 Child Run", () => {
  it("未启用 Session 时，加载事实先持久化，删除源文件后冷恢复仍重建原正文", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-skills-resume-"));
    const source = await writeSkill(directory);
    const runId = "skill-sessionless-resume";
    const storeDirectory = path.join(directory, ".coremind", "runs");
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    const commits: Array<{
      record: RunStateRecord;
      requested: RunStoreDurability;
      acknowledgement: RunStoreDurabilityAcknowledgement;
    }> = [];
    const commit = FileRunStore.prototype.commit;
    const commitSpy = vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(async function (
      this: FileRunStore,
      record,
      requested,
    ) {
      const acknowledgement = await commit.call(this, record, requested);
      commits.push({ record, requested, acknowledgement });
      return acknowledgement;
    });
    let persistedBeforeSecond: RunStateRecord[] = [];
    let acknowledgedBeforeSecond: typeof commits = [];
    const server = provider(async (request) => {
      requests.push(request);
      if (requests.length === 2) {
        acknowledgedBeforeSecond = [...commits];
        persistedBeforeSecond = await new FileRunStore(storeDirectory).read(runId);
        return { tool: "read", args: { path: "forbidden.txt" } };
      }
      if (requests.length === 1 || requests.length === 3) {
        return { tool: "load_skill", args: { id: skillId } };
      }
      return "恢复后完成";
    }, failures);
    try {
      await listen(server);
      const config: CoreMindConfig = {
        ...baseConfig(portOf(server)),
        agents: { main: { systemPrompt: "使用已授权技能", skills: [skillId] } },
        tools: [{ id: "read" }],
        session: { enabled: false },
        permissions: {
          mode: "ask",
          allow: ["load_skill"],
          deny: ["read"],
          workspaceOnly: true,
          network: "deny",
        },
      };
      const options = { config, configDir: directory, cwd: directory, initialPrompt: "保持原输入" };
      const first = await CoreMindRuntime.create({ ...options, runId });
      const paused = await first.run();
      expect(failures).toEqual([]);
      expect(
        paused.outcome,
        JSON.stringify({
          outcome: paused.outcome,
          trace: paused.trace.filter((entry) =>
            ["policy_denied", "error"].includes(entry.event.type),
          ),
        }),
      ).toMatchObject({ status: "paused", finishReason: "tool_approval_denied" });
      expect(paused.snapshot.resumable).toBe(true);
      expect(paused.releaseReadiness.ready).toBe(false);
      expect(requests).toHaveLength(2);
      const snapshot = startSnapshot(persistedBeforeSecond);
      expect(snapshot.agents.main!.standard).toEqual([
        { id: skillId, name: skillName, description, body, bodySha256 },
      ]);
      const loaded = skillLoads(persistedBeforeSecond);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({
        event: { type: "tool_result", agent: "main", tool: "load_skill", isError: false },
        skillLoad: {
          version: 1,
          id: skillId,
          bodySha256,
          snapshotSha256: snapshot.sha256,
          delivery: "body",
        },
      });
      for (const record of persistedBeforeSecond.filter(
        (item) => item.kind === "start" || skillLoads([item]).length > 0,
      )) {
        expect(
          acknowledgedBeforeSecond.find((item) => item.record.sequence === record.sequence),
        ).toMatchObject({
          requested: "critical",
          acknowledgement: {
            requested: "critical",
            achieved: "critical",
            boundary: "process_crash",
          },
        });
      }
      expect(toolTexts(requests[1]!)).toEqual([renderedBody]);
      const records = await new FileRunStore(storeDirectory).read(runId);
      expect(events(records)).toContainEqual(
        expect.objectContaining({
          type: "policy_denied",
          tool: "read",
          reason: expect.stringContaining("permissions.deny"),
        }),
      );
      expect(events(records)).toContainEqual(
        expect.objectContaining({
          type: "tool_lifecycle",
          tool: "read",
          resolution: expect.objectContaining({ phase: "executing", status: "skipped" }),
        }),
      );
      expect(
        events(records).filter(
          (event) => event.type === "tool_result" && event.tool === "read" && !event.isError,
        ),
      ).toEqual([]);
      const restored = restoreSkillSnapshot(records, config.agents)!;
      expect(rebuildSkillResult(restored, "main", loaded[0]!.skillLoad)).toEqual({
        content: [{ type: "text", text: renderedBody }],
        details: { id: skillId, bodySha256, delivery: "body" },
      });

      await rm(source);
      const resumed = await CoreMindRuntime.create({ ...options, resumeRunId: runId });
      const completed = await resumed.run();
      const finalRecords = await new FileRunStore(storeDirectory).read(runId);
      const resumedEvents = events(
        finalRecords.filter((record) => record.sequence > records.at(-1)!.sequence),
      );
      const resumeDiagnosis = JSON.stringify({
        outcome: completed.outcome,
        providerRequests: requests.length,
        previousPolicyDenied: events(records).filter((event) => event.type === "policy_denied"),
        resumedEvents,
        terminal: finalRecords.at(-1),
      });
      expect(failures).toEqual([]);
      expect(completed.runId).toBe(runId);
      expect(requests, resumeDiagnosis).toHaveLength(4);
      expect(
        resumedEvents.filter((event) => event.type === "policy_denied"),
        resumeDiagnosis,
      ).toEqual([]);
      for (const request of [requests[0]!, requests[2]!]) {
        const text = requestText(request);
        for (const value of [skillId, skillName, description, bodySha256])
          expect(text).toContain(value);
        expect(text).not.toContain(body);
      }
      expect(toolTexts(requests[3]!)).toEqual([renderedBody]);
      expect(startSnapshot(finalRecords)).toEqual(snapshot);
      expect(skillLoads(finalRecords).map((item) => item.skillLoad)).toEqual([
        loaded[0]!.skillLoad,
        loaded[0]!.skillLoad,
      ]);
      expect(completed.outcome.status, resumeDiagnosis).toBe("succeeded");
      expect(config.permissions).toEqual({
        mode: "ask",
        allow: ["load_skill"],
        deny: ["read"],
        workspaceOnly: true,
        network: "deny",
      });
      await expect(readdir(path.join(directory, "sessions"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      commitSpy.mockRestore();
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("父 Agent 未选技能时，真实 Child Run 仍只加载父 start 冻结的目标技能", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-skills-child-"));
    const source = await writeSkill(directory);
    const runId = "skill-parent-frozen-child";
    let parentPrepared = false;
    let rewritten = false;
    const store = new FileRunStore(path.join(directory, ".coremind", "runs"), {
      beforeCommit: ({ record }) => {
        if (record?.kind === "start" && record.runId === runId) parentPrepared = true;
      },
    });
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    const approvals: ToolApprovalRequest[] = [];
    const server = provider(async (request) => {
      requests.push(request);
      const tools = request.tools?.map((tool) => tool.function?.name) ?? [];
      if (request.model === "probe-model" && tools.includes("delegate") && requests.length === 1) {
        if (!parentPrepared) throw new Error("父 start 尚未经过真实 beforeCommit");
        startSnapshot(
          await new FileRunStore(path.join(directory, ".coremind", "runs")).read(runId),
        );
        await writeFile(source, frontmatter + "父 start 后改写的错误正文\n", "utf8");
        rewritten = true;
        return {
          tool: "delegate",
          args: {
            target: "researcher",
            task: "按冻结技能完成任务",
            references: [],
            limits: { tokens: 2_000 },
          },
        };
      }
      if (
        request.model === "child-model" &&
        tools.includes("load_skill") &&
        requests.length === 2
      ) {
        return { tool: "load_skill", args: { id: skillId } };
      }
      if (request.model === "child-model" && requests.length === 3) return "子任务完成";
      if (request.model === "probe-model" && requests.length === 4) return "父任务完成";
      throw new Error(`意外模型请求：${request.model}/${requests.length}`);
    }, failures);
    try {
      await listen(server);
      const allocation = {
        tokens: 2_000,
        toolCalls: 1,
        costUsd: 1,
        wallTimeMs: 20_000,
        steps: 2,
        descendants: 0,
      };
      const config: CoreMindConfig = {
        ...baseConfig(portOf(server)),
        agents: {
          main: {
            systemPrompt: "父 Agent 只委派任务",
            delegation: {
              budget: { ...allocation, descendants: 1 },
              targets: { researcher: { budget: allocation } },
            },
          },
          researcher: {
            systemPrompt: "子 Agent 按已选技能完成任务",
            model: "child-model",
            skills: [skillId],
          },
        },
        permissions: {
          mode: "ask",
          allow: ["load_skill"],
          workspaceOnly: true,
          network: "deny",
        },
      };
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        initialPrompt: "执行受控委派",
        runId,
        runStore: store,
        approveTool: async (request) => {
          approvals.push(request);
          return request.tool === "delegate" ? "allow" : "deny";
        },
      });
      const result = await runtime.run();
      const parentRecords = await store.read(runId);
      const diagnosis =
        result.outcome.status === "succeeded"
          ? undefined
          : JSON.stringify({
              outcome: result.outcome,
              childRuns: result.childRuns,
              approvals,
              models: requests.map((request) => request.model),
              parentEvents: events(parentRecords),
              children: await Promise.all(
                (result.childRuns?.nodes ?? []).map(async (node) => ({
                  runId: node.childRunId,
                  events: events(await store.read(node.childRunId)),
                })),
              ),
            });
      expect(failures).toEqual([]);
      expect(result.outcome.status, diagnosis).toBe("succeeded");
      expect(rewritten).toBe(true);
      expect(requests.map((request) => request.model)).toEqual([
        "probe-model",
        "child-model",
        "child-model",
        "probe-model",
      ]);
      expect(requests[0]!.tools?.some((tool) => tool.function?.name === "load_skill")).toBe(false);
      expect(requests[1]!.tools?.map((tool) => tool.function?.name)).toEqual(["load_skill"]);
      expect(requestText(requests[1]!)).toContain(bodySha256);
      expect(requestText(requests[1]!)).not.toContain(body);
      expect(toolTexts(requests[2]!)).toEqual([renderedBody]);
      expect(requests.map(requestText).join("\n")).not.toContain("父 start 后改写的错误正文");
      const snapshot = startSnapshot(parentRecords);
      expect(snapshot.agents.main!.standard).toEqual([]);
      expect(snapshot.agents.researcher!.standard[0]).toEqual({
        id: skillId,
        name: skillName,
        description,
        body,
        bodySha256,
      });
      expect(skillLoads(parentRecords)).toEqual([]);
      const delegation = parentRecords.find(
        (record) =>
          record.kind === "delegation" &&
          (record.payload as { type?: string }).type === "delegation_recorded",
      )!.payload as {
        childRunId: string;
        inputFingerprint: string;
        model: { agentPromptFingerprint: string };
      };
      expect(approvals).toHaveLength(1);
      const approved = approvals[0]!;
      expect(approved).toMatchObject({
        runId,
        agent: "main",
        tool: "delegate",
        args: {
          target: "researcher",
          task: "按冻结技能完成任务",
          references: [],
          limits: allocation,
        },
        argumentsFingerprint: fingerprintEffectReceiptValue(approved.args),
        delegationInputFingerprint: delegation.inputFingerprint,
      });
      expect(approved.delegationInputFingerprint).toBeTruthy();
      expect(events(parentRecords).filter((event) => event.type === "approval_required")).toEqual([
        expect.objectContaining({
          approvalId: approved.approvalId,
          runId,
          agent: "main",
          tool: "delegate",
          argumentsFingerprint: approved.argumentsFingerprint,
          delegationInputFingerprint: delegation.inputFingerprint,
        }),
      ]);
      expect(events(parentRecords).filter((event) => event.type === "approval_resolved")).toEqual([
        expect.objectContaining({
          approvalId: approved.approvalId,
          runId,
          decision: "allow",
          argumentsFingerprint: approved.argumentsFingerprint,
          delegationInputFingerprint: delegation.inputFingerprint,
        }),
      ]);
      expect(delegation.model.agentPromptFingerprint).toBe(
        fingerprintEffectReceiptValue({
          systemPrompt: config.agents.researcher!.systemPrompt,
          skillsContent: skillPrefixContents(snapshot.agents.researcher!),
        }),
      );
      const childRecords = await store.read(delegation.childRunId);
      expect(events(childRecords).filter((event) => event.type === "approval_required")).toEqual(
        [],
      );
      expect(startSnapshot(childRecords)).toEqual(snapshot);
      expect(skillLoads(childRecords)).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_result",
            agent: "researcher",
            tool: "load_skill",
            isError: false,
          }),
          skillLoad: {
            version: 1,
            id: skillId,
            bodySha256,
            snapshotSha256: snapshot.sha256,
            delivery: "body",
          },
        }),
      ]);
      const system = requests[1]!.messages.find((message) => message.role === "system")!;
      expect(events(childRecords)).toContainEqual(
        expect.objectContaining({
          type: "context_prefix",
          agent: "researcher",
          fingerprint: createHash("sha256").update(textOf(system.content), "utf8").digest("hex"),
        }),
      );
      expect(result.childRuns).toMatchObject({
        activeDescendants: 0,
        nodes: [{ status: "joined", outcome: { status: "succeeded" } }],
      });
      expect(config.permissions).toEqual({
        mode: "ask",
        allow: ["load_skill"],
        workspaceOnly: true,
        network: "deny",
      });
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("技能加载结果的关键 barrier 失败时，不得进入下一次 Provider 业务请求", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-skills-barrier-"));
    await writeSkill(directory);
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    const rejected: RunStateRecord[] = [];
    const store = new FileRunStore(path.join(directory, ".coremind", "runs"), {
      beforeBarrier: ({ record }) => {
        if (record && skillLoads([record]).length > 0) {
          rejected.push(record);
          throw new Error("技能加载结果的关键持久化被拒绝");
        }
      },
    });
    const server = provider(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { tool: "load_skill", args: { id: skillId } }
        : "持久化失败后不应请求此业务轮";
    }, failures);
    try {
      await listen(server);
      const runtime = await CoreMindRuntime.create({
        config: {
          ...baseConfig(portOf(server)),
          agents: { main: { systemPrompt: "加载已选技能", skills: [skillId] } },
          permissions: { mode: "ask", allow: ["load_skill"], workspaceOnly: true, network: "deny" },
        },
        configDir: directory,
        cwd: directory,
        initialPrompt: "加载后继续",
        runStore: store,
      });
      const result = await runtime.run();
      expect(failures).toEqual([]);
      expect(result.outcome, JSON.stringify(result.outcome)).toMatchObject({
        status: "failed",
        error: { code: "durability_barrier_failed" },
      });
      expect(requests).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(skillLoads(rejected)[0]).toMatchObject({
        event: { type: "tool_result", tool: "load_skill", isError: false },
        skillLoad: { id: skillId, bodySha256, delivery: "body" },
      });
      const records = await store.read(result.runId);
      expect(startSnapshot(records).agents.main!.standard[0]!.body).toBe(body);
      expect(skillLoads(records)).toEqual([]);
      expect(result.trace.map((entry) => entry.event)).toContainEqual(
        expect.objectContaining({
          type: "tool_lifecycle",
          tool: "load_skill",
          resolution: expect.objectContaining({
            phase: "result_durable",
            status: "failed",
            result: expect.objectContaining({ persistenceState: "failed" }),
          }),
        }),
      );
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("真实 Working Set 压缩移除正文后，重新加载原冻结正文并与 Session 重建一致", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-skills-compaction-"));
    const source = await writeSkill(directory);
    const runId = "skill-context-reload";
    const sessionId = "skill-compaction";
    const sessionOptions = { dir: path.join(directory, "sessions"), sessionId, cwd: directory };
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    const controls: ControlReceipt[] = [];
    let compactedEntries: Awaited<ReturnType<CoreMindSession["branchEntries"]>> = [];
    let runtime!: CoreMindRuntime;
    const server = provider(async (request) => {
      requests.push(request);
      if (requests.length === 1 || requests.length === 4) {
        if (requests.length === 4) {
          compactedEntries = await (await CoreMindSession.open(sessionOptions)).branchEntries();
        }
        return { tool: "load_skill", args: { id: skillId } };
      }
      if (requests.length === 2 || requests.length === 3) {
        const ordinal = requests.length;
        controls.push(
          await runtime.acceptControl({
            schemaVersion: 1,
            runId,
            controlId: `skill-follow-${ordinal}`,
            type: "follow_up",
            message: ordinal === 2 ? "第二轮：完成一个独立的短任务" : "第三轮：再次显式加载原技能",
          }),
        );
        if (ordinal === 2)
          await writeFile(source, frontmatter + "压缩之前改写的错误正文\n", "utf8");
        // 按现有字符估算器，每轮 4000 token；两轮累计才超预算，最近完整轮次仍可保留。
        return (ordinal === 2 ? "A" : "B").repeat(16_000);
      }
      if (requests.length === 5) return "压缩后重载完成";
      throw new Error(`压缩夹具出现额外请求：${requests.length}`);
    }, failures);
    try {
      await listen(server);
      const config: CoreMindConfig = {
        ...baseConfig(portOf(server)),
        provider: {
          ...baseConfig(portOf(server)).provider!,
          contextWindow: 12_288,
          maxTokens: 4_096,
        },
        agents: { main: { systemPrompt: "按已选技能完成每个独立轮次", skills: [skillId] } },
        permissions: { mode: "ask", allow: ["load_skill"], workspaceOnly: true, network: "deny" },
        session: { enabled: true, compact: false },
        runtime: { ...baseConfig(portOf(server)).runtime, maxTurns: 6, maxTokens: 32_768 },
      };
      runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        initialPrompt: "第一轮：加载技能后结束本轮",
        runId,
        sessionId,
      });
      const result = await runtime.run();
      const records = await new FileRunStore(path.join(directory, ".coremind", "runs")).read(runId);
      const diagnosis = JSON.stringify({
        outcome: result.outcome,
        requests: requests.length,
        controls,
        trace: events(records).filter((event) =>
          [
            "context_compacted",
            "context_lifecycle_failed",
            "context_budget_resolved",
            "error",
          ].includes(event.type),
        ),
      });
      expect(failures).toEqual([]);
      expect(result.outcome.status, diagnosis).toBe("succeeded");
      expect(requests, diagnosis).toHaveLength(5);
      expect(controls.map((receipt) => receipt.status)).toEqual(["applied", "applied"]);
      expect(toolTexts(requests[1]!)).toEqual([renderedBody]);
      expect(requestText(requests[3]!)).not.toContain(body);
      expect(requestText(requests[3]!)).toContain("[CoreMind TaskState v1]");
      expect(toolTexts(requests[3]!)).toEqual([]);
      expect(toolTexts(requests[4]!)).toEqual([renderedBody]);
      expect(requests.map(requestText).join("\n")).not.toContain("压缩之前改写的错误正文");
      const snapshot = startSnapshot(records);
      expect(skillLoads(records).map((item) => item.skillLoad)).toEqual([
        { version: 1, id: skillId, bodySha256, snapshotSha256: snapshot.sha256, delivery: "body" },
        { version: 1, id: skillId, bodySha256, snapshotSha256: snapshot.sha256, delivery: "body" },
      ]);
      const compacted = events(records).filter((event) => event.type === "context_compacted");
      expect(compacted, diagnosis).toHaveLength(1);
      const compactions = compactedEntries.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect(compacted[0]).toMatchObject({ sessionEntryId: compactions[0]!.id });
      expect(
        compactions[0]!.retainedTail
          .map((message) => textOf("content" in message ? message.content : ""))
          .join("\n"),
      ).not.toContain(body);
      const finalEntries = await (await CoreMindSession.open(sessionOptions)).branchEntries();
      for (const [entries, request] of [
        [compactedEntries, requests[3]!],
        [finalEntries, requests[4]!],
      ] as const) {
        const prefix = textOf(
          request.messages.find((message) => message.role === "system")!.content,
        );
        const rebuilt = rebuildRunRequest({
          entries,
          compactions: entries.filter((entry) => entry.type === "compaction"),
          stablePrefix: {
            text: prefix,
            fingerprint: createHash("sha256").update(prefix, "utf8").digest("hex"),
          },
        });
        expect(
          rebuilt.map((message) => ({
            role: message.role === "toolResult" ? "tool" : message.role,
            text: textOf("content" in message ? message.content : ""),
          })),
        ).toEqual(
          request.messages.map((message) => ({
            role: message.role,
            text: textOf(message.content),
          })),
        );
      }
      const persistedLoads = finalEntries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "load_skill",
      );
      expect(persistedLoads).toHaveLength(2);
      for (const entry of persistedLoads) {
        if (entry.type === "message" && entry.message.role === "toolResult")
          expect(textOf(entry.message.content)).toBe(renderedBody);
      }
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function baseConfig(port: number): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "标准技能真实恢复与委派",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents: { main: {} },
    defaultAgent: "main",
    runtime: {
      maxTurns: 4,
      maxSteps: 4,
      maxToolCalls: 4,
      maxTokens: 8_000,
      maxCostUsd: 2,
      maxRetries: 0,
      runTimeoutMs: 25_000,
    },
  };
}

async function writeSkill(directory: string): Promise<string> {
  const folder = path.join(directory, "skills", skillId);
  await mkdir(folder, { recursive: true });
  const source = path.join(folder, "SKILL.md");
  await writeFile(source, frontmatter + body, "utf8");
  return source;
}

function startSnapshot(records: RunStateRecord[]): SkillSnapshot {
  const snapshot = (
    records.find((record) => record.kind === "start")?.payload as
      | { skillSnapshot?: SkillSnapshot }
      | undefined
  )?.skillSnapshot;
  expect(snapshot).toBeDefined();
  return snapshot!;
}

function skillLoads(
  records: RunStateRecord[],
): Array<{ event: Extract<CoreMindEvent, { type: "tool_result" }>; skillLoad: SkillLoadFact }> {
  return records.flatMap((record) => {
    const payload = record.payload as { event?: CoreMindEvent; skillLoad?: SkillLoadFact };
    return record.kind === "event" && payload.event?.type === "tool_result" && payload.skillLoad
      ? [{ event: payload.event, skillLoad: payload.skillLoad }]
      : [];
  });
}

function events(records: RunStateRecord[]): CoreMindEvent[] {
  return records.flatMap((record) =>
    record.kind === "event" ? [(record.payload as { event: CoreMindEvent }).event] : [],
  );
}

function textOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : "";
}

function requestText(request: WireRequest): string {
  return request.messages.map((message) => textOf(message.content)).join("\n");
}

function toolTexts(request: WireRequest): string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => textOf(message.content));
}

function provider(
  step: (request: WireRequest) => Promise<string | { tool: string; args: unknown }>,
  failures: unknown[],
) {
  let ordinal = 0;
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const reply = await step(JSON.parse(body));
        ordinal += 1;
        const delta =
          typeof reply === "string"
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `skill-call-${ordinal}`,
                    type: "function",
                    function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                  },
                ],
              };
        sendSse(response, [
          { id: `skill-response-${ordinal}`, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: `skill-response-${ordinal}`,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: typeof reply === "string" ? "stop" : "tool_calls",
              },
            ],
          },
        ]);
      })().catch((error: unknown) => {
        failures.push(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "技能验收夹具失败" } }));
      });
    });
  });
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function portOf(server: ReturnType<typeof createServer>): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
