import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export async function startSkillFixture(cases, skillIds) {
  const byPrompt = new Map(cases.map((item) => [item.prompt, item]));
  const usage = new Map();
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      request.setEncoding("utf8");
      let body = "";
      for await (const part of request) body += part;
      const { messages, tools = [] } = JSON.parse(body);
      const prompt = textOf(messages.findLast(({ role }) => role === "user"));
      const item = byPrompt.get(prompt);
      assert.ok(item, "回环夹具收到未登记题目");
      const enabled = tools.some(({ function: tool }) => tool.name === "load_skill");
      const system = messages
        .filter(({ role }) => role === "system" || role === "developer")
        .map(textOf)
        .join("\n");
      for (const id of skillIds)
        assert.equal(
          system.includes(id),
          enabled,
          `${id} (${messages.map(({ role }) => role).join(", ")})`,
        );
      const returned = messages.filter(({ role }) => role === "tool").map(textOf);
      const calls =
        enabled && item.skill
          ? [
              { id: item.skill },
              ...item.resources.map((resource) => ({ id: item.skill, resource })),
            ]
          : [];
      assert.deepEqual(
        messages
          .flatMap(({ tool_calls }) => tool_calls ?? [])
          .map(({ function: tool }) => JSON.parse(tool.arguments)),
        calls.slice(0, returned.length),
      );
      if (returned.length) assert.match(returned[0], /输出|JSON/u);
      const next = calls[returned.length];
      const delta = next
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `skill-${returned.length}`,
                type: "function",
                function: { name: "load_skill", arguments: JSON.stringify(next) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(fixtureOutput(item, returned.slice(1))) };
      // 字节数只用于生成可核对的模拟 Provider 用量。
      const inputTokens = Math.ceil(Buffer.byteLength(body, "utf8") / 4);
      const outputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(delta), "utf8") / 4);
      const key = `${item.id}:${enabled}`;
      const total = usage.get(key) ?? { inputTokens: 0, outputTokens: 0 };
      total.inputTokens += inputTokens;
      total.outputTokens += outputTokens;
      usage.set(key, total);
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        },
      ]) {
        response.write(`data: ${JSON.stringify({ id: "skill-holdout", ...chunk })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    usage,
    failures,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function textOf({ content } = {}) {
  return typeof content === "string" ? content : (content ?? []).map(({ text }) => text).join("");
}

function fixtureOutput({ id, prompt, skill }, resources) {
  if (skill && resources.length === 0) return { 说明: "当前对话未提供适用的表单或检查规则。" };
  if (skill === "shared-weekly-report") {
    const [, department, completed, blocked, planned] = prompt.match(
      /^请整理(.+)的周报并输出 JSON。已完成：([^。]+)。阻碍：([^。]+)。下周计划：([^。]+)。$/u,
    );
    const [rules, template] = resources;
    assert.match(rules, /`本周交付`.*`需协调`.*`下周承诺`/u);
    return Object.assign(JSON.parse(template), {
      部门: department,
      本周交付: [completed],
      需协调: [blocked],
      下周承诺: [planned],
    });
  }
  if (skill === "shared-release-preflight") {
    const [, project, environment, node, snapshot, reviewer] = prompt.match(
      /^请为(.+)项目的(.+)环境做交付前检查并输出 JSON。环境现状：Node\.js ([\d.]+)；([^；]+)；([^。]+)。$/u,
    );
    const [rules, checklist, source] = resources;
    assert.match(rules, /可交付.*暂缓交付/u);
    assert.match(source, /compareVersions/u);
    const checks = JSON.parse(checklist);
    const confirmed = {
      node:
        node.localeCompare(checks.find(({ id }) => id === "node").minimum, "en", {
          numeric: true,
        }) >= 0,
      snapshot: snapshot === "已保存回滚快照",
      reviewer: reviewer === "已指定复核人",
    };
    const missing = checks.filter(({ id }) => !confirmed[id]).map(({ missing }) => missing);
    return {
      项目: project,
      环境: environment,
      交付结论: missing.length ? "暂缓交付" : "可交付",
      缺项: missing,
    };
  }
  if (id === "holdout-weekly-copyedit") return { 改写: "请于今天发送周报，并抄送值班组。" };
  assert.equal(id, "holdout-release-extract");
  return { 日期: prompt.match(/便笺：(周.)/u)[1] };
}
