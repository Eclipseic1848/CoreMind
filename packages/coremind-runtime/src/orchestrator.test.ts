import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { WorkflowStep } from "coremind-config";
import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import { evalCondition, Orchestrator } from "./orchestrator.js";

let instanceCounter = 0;

/**
 * 构造一个响应固定文本的 Agent（每次 prompt 消耗一个响应）。
 * 注意：faux provider 的响应队列按 provider id 在模块级共享，
 * 因此每个实例必须使用唯一 provider id，避免并发实例互相干扰。
 */
function makeAgent(name: string, responses: FauxResponseStep[]): Agent {
  instanceCounter += 1;
  const providerId = `faux-${name}-${instanceCounter}`;
  const models = createModels();
  const faux = fauxProvider({ provider: providerId });
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return new Agent({
    initialState: { systemPrompt: name, model: faux.getModel(), tools: [], messages: [] },
    streamFn: (m, c, o) => models.streamSimple(m, c, o),
  });
}

const events: string[] = [];
function track(event: { type: string }): void {
  events.push(event.type);
}

/**
 * 按名字 → 响应列表构建 agent 工厂。
 * 同一名字每次创建新实例，并按"已创建次数"切分响应——
 * 第 n 次创建的实例从响应列表第 n 个开始消费（模拟真实模型的顺序输出）。
 */
function run(
  steps: WorkflowStep[],
  defs: Record<string, FauxResponseStep[]>,
  initialPrompt?: string,
) {
  const counters = new Map<string, number>();
  return new Orchestrator(steps, {
    createAgent: (name) => {
      const responses = defs[name];
      if (!responses) return undefined;
      const index = counters.get(name) ?? 0;
      counters.set(name, index + 1);
      return makeAgent(name, responses.slice(index));
    },
    events: track,
    initialPrompt,
  }).run();
}

describe("evalCondition", () => {
  it("空串为假、字面量 true/false 直判", () => {
    expect(evalCondition("")).toBe(false);
    expect(evalCondition("true")).toBe(true);
    expect(evalCondition("false")).toBe(false);
  });

  it("contains / == / != 比较", () => {
    expect(evalCondition("abc contains b")).toBe(true);
    expect(evalCondition("abc contains z")).toBe(false);
    expect(evalCondition("a == a")).toBe(true);
    expect(evalCondition("a != b")).toBe(true);
    expect(evalCondition("a == b")).toBe(false);
  });

  it("其他非空内容为真", () => {
    expect(evalCondition("任何内容")).toBe(true);
  });
});

describe("Orchestrator", () => {
  it("顺序执行并保存输出、变量插值", async () => {
    const outputs = await run(
      [
        { id: "s1", type: "prompt", agent: "a", input: "第一问", saveAs: "first" },
        {
          id: "s2",
          type: "prompt",
          agent: "b",
          input: "请基于 {{first.text}} 处理",
          saveAs: "second",
        },
      ],
      {
        a: [fauxAssistantMessage("第一步结果")],
        b: [fauxAssistantMessage("基于：第一步结果 的第二步")],
      },
    );
    expect(outputs.get("first")?.text).toContain("第一步结果");
    expect(outputs.get("second")?.text).toContain("第二步");
    // 事件序列包含步骤边界
    expect(events).toContain("step_start");
    expect(events).toContain("step_end");
  });

  it("if 分支：condition 命中 then", async () => {
    const outputs = await run(
      [
        { id: "s1", type: "prompt", agent: "a", input: "收集", saveAs: "changes" },
        {
          id: "s2",
          type: "if",
          condition: "{{changes.text}} contains 无",
          then: [{ id: "s3", type: "prompt", agent: "b", input: "写说明", saveAs: "report" }],
          else: [{ id: "s4", type: "prompt", agent: "b", input: "写正式周报", saveAs: "report" }],
        },
      ],
      {
        a: [fauxAssistantMessage("无任何变更")],
        b: [fauxAssistantMessage("生成了说明性周报")],
      },
    );
    expect(outputs.get("report")?.text).toContain("说明性");
  });

  it("if 分支：condition 未命中走 else", async () => {
    const outputs = await run(
      [
        { id: "s1", type: "prompt", agent: "a", input: "收集", saveAs: "changes" },
        {
          id: "s2",
          type: "if",
          condition: "{{changes.text}} contains 无",
          then: [{ id: "s3", type: "prompt", agent: "b", input: "写说明" }],
          else: [{ id: "s4", type: "prompt", agent: "b", input: "写正式周报", saveAs: "report" }],
        },
      ],
      {
        a: [fauxAssistantMessage("有 5 个提交")],
        b: [fauxAssistantMessage("正式周报完成")],
      },
    );
    expect(outputs.get("report")?.text).toContain("正式");
  });

  it("switch 分支：按变量包含值命中", async () => {
    const outputs = await run(
      [
        { id: "s1", type: "call", agent: "c", input: "分类", saveAs: "category" },
        {
          id: "s2",
          type: "switch",
          on: "category.text",
          cases: {
            投诉: [{ id: "s3", type: "call", agent: "r", input: "起草投诉回复", saveAs: "reply" }],
            咨询: [{ id: "s4", type: "call", agent: "r", input: "起草咨询回复", saveAs: "reply" }],
          },
        },
      ],
      {
        c: [fauxAssistantMessage("投诉")],
        r: [fauxAssistantMessage("投诉回复草稿")],
      },
    );
    expect(outputs.get("reply")?.text).toContain("投诉");
  });

  it("parallel 并行执行并聚合输出（同一 agent 多子步骤）", async () => {
    const outputs = await run(
      [
        {
          id: "p1",
          type: "parallel",
          steps: [
            { id: "p2", type: "prompt", agent: "col", input: "构建", saveAs: "build" },
            { id: "p3", type: "prompt", agent: "col", input: "测试", saveAs: "tests" },
          ],
          saveAs: "checks",
        },
        { id: "p4", type: "call", agent: "w", input: "写周报 {{checks.text}}", saveAs: "report" },
      ],
      {
        col: [fauxAssistantMessage("构建成功"), fauxAssistantMessage("测试 12 通过")],
        w: [fauxAssistantMessage("周报完成")],
      },
    );
    expect(outputs.get("build")?.text).toContain("构建成功");
    expect(outputs.get("tests")?.text).toContain("测试");
    expect(outputs.get("checks")?.text).toContain("构建成功");
    expect(outputs.get("checks")?.text).toContain("测试");
    expect(outputs.get("report")?.text).toContain("周报");
  });

  it("多 agent 互相调用（call 步骤 + {{prompt}} 变量）", async () => {
    const outputs = await run(
      [
        { id: "d", type: "call", agent: "an", input: "诊断 {{prompt}}", saveAs: "diag" },
        { id: "f", type: "call", agent: "pa", input: "修复：{{diag.text}}", saveAs: "fix" },
      ],
      {
        an: [fauxAssistantMessage("根因分析")],
        pa: [fauxAssistantMessage("修复完成")],
      },
      "系统报错",
    );
    expect(outputs.get("diag")?.text).toContain("根因");
    expect(outputs.get("fix")?.text).toContain("修复");
  });

  it("引用未定义 agent 抛 CoreMindError", async () => {
    await expect(
      run([{ id: "s1", type: "prompt", agent: "ghost", input: "hi" }], {
        a: [fauxAssistantMessage("x")],
      }),
    ).rejects.toThrow(CoreMindError);
  });

  it("嵌套深度超限抛 step_limit", async () => {
    // 构造深嵌套：parallel 内嵌 parallel，深度 12 层（超过默认 8）
    let steps: WorkflowStep[] = [{ id: "s0", type: "prompt", agent: "a", input: "x" }];
    for (let i = 1; i <= 12; i++) {
      steps = [{ id: `s${i}`, type: "parallel", steps }];
    }
    await expect(run(steps, { a: [fauxAssistantMessage("x")] })).rejects.toThrow(CoreMindError);
  });
});
