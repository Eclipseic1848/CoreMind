import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const example = import.meta.dirname;
const root = path.resolve(example, "../../..");
const cases = JSON.parse(await readFile(path.join(example, "cases.json"), "utf8"));
const yaml = await readFile(path.join(example, "coremind.yaml"), "utf8");
const exec = promisify(execFile);
const key = "local-skill-fixture";
const sentinel = "skill-script-executed.txt";

function textOf({ content }) {
  return typeof content === "string" ? content : content.map((part) => part.text).join("");
}

function reply(request, response, delta, finishReason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [chunk, reason] of [
    [delta, null],
    [{}, finishReason],
  ]) {
    const data = { id: request, choices: [{ index: 0, delta: chunk, finish_reason: reason }] };
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function composeOutput(prompt, skill, resourceTexts) {
  if (skill === "shared-weekly-report") {
    const [, department, completed, blocked, planned] = prompt.match(
      /^请整理(.+)的周报并输出 JSON。已完成：([^。]+)。阻碍：([^。]+)。下周计划：([^。]+)。$/u,
    );
    const [rules, template] = resourceTexts;
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
    const [rules, checklist, source] = resourceTexts;
    assert.match(rules, /可交付.*暂缓交付/u);
    assert.match(source, /compareVersions/u);
    assert.match(source, /skill-script-executed\.txt/u);
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
  const [, notice] = prompt.split("的 JSON。");
  return { 摘要: notice.replace("暂停开放以更换门禁", "因更换门禁暂停开放") };
}

let active;
const provider = createServer(async (request, response) => {
  const task = active;
  try {
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const { messages, tools } = JSON.parse(body);
    assert.deepEqual(
      tools.map(({ function: tool }) => tool.name),
      ["load_skill"],
    );
    const prompt = textOf(messages.findLast(({ role }) => role === "user"));
    assert.equal(prompt, task.case.prompt);

    const returned = messages.filter(({ role }) => role === "tool").map(textOf);
    const step = task.requests++;
    assert.equal(returned.length, step, "技能工具结果数量与调用轮次不一致");
    if (step === 0) {
      const prefix = messages
        .filter(({ role }) => role === "system")
        .map(textOf)
        .join("\n");
      for (const id of ["shared-weekly-report", "shared-release-preflight"]) {
        assert.ok(prefix.includes(id), `首轮缺少技能索引 ${id}`);
      }
      for (const privateText of [task.body, ...task.resources].filter(Boolean)) {
        assert.ok(!prefix.includes(privateText), "正文或资源出现在首次模型请求中");
      }
    } else {
      assert.ok(returned[0].endsWith(task.body), "工具未返回冻结的 Skill 正文");
      assert.deepEqual(returned.slice(1), task.resources.slice(0, step - 1));
      const previous = messages.flatMap(({ tool_calls }) => tool_calls ?? []);
      assert.deepEqual(
        previous.map(({ function: tool }) => JSON.parse(tool.arguments)),
        task.calls.slice(0, step),
      );
    }

    const next = task.calls[step];
    if (next) {
      reply(
        request.url,
        response,
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `skill-${step}`,
              type: "function",
              function: { name: "load_skill", arguments: JSON.stringify(next) },
            },
          ],
        },
        "tool_calls",
      );
    } else {
      const output = composeOutput(prompt, task.case.skill, returned.slice(1));
      reply(request.url, response, { role: "assistant", content: JSON.stringify(output) }, "stop");
    }
  } catch (error) {
    task.error = error;
    response.writeHead(500).end();
  }
});

const workspace = await mkdtemp(path.join(tmpdir(), "coremind-skill-fixture-"));
try {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const { port } = provider.address();
  const { COREMIND_SKILL_PYTHON = "python" } = process.env;
  const env = {
    ...process.env,
    COREMIND_SKILL_FIXTURE_KEY: key,
    PYTHONPATH: path.join(root, "python/src"),
    PYTHONIOENCODING: "utf-8",
  };
  for (const scenario of cases) {
    const { id, prompt, skill, resources, expected } = scenario;
    const calls = skill
      ? [{ id: skill }, ...resources.map((resource) => ({ id: skill, resource }))]
      : [];
    const pack = path.join(example, "skills", skill ?? "");
    const body = skill
      ? (await readFile(path.join(pack, "SKILL.md"), "utf8")).split("\n---\n", 2)[1]
      : undefined;
    const resourceTexts = await Promise.all(
      resources.map((file) => readFile(path.join(pack, file), "utf8")),
    );
    for (const entry of ["CLI + YAML", "TypeScript SDK", "Python SDK", "Python Async SDK"]) {
      const cwd = await mkdtemp(path.join(workspace, "project-"));
      const config = path.join(cwd, "coremind.yaml");
      await writeFile(config, yaml.replace("127.0.0.1:8771", `127.0.0.1:${port}`), "utf8");
      await cp(path.join(example, "skills"), path.join(cwd, "skills"), { recursive: true });
      const cli = entry === "CLI + YAML";
      const python = entry.startsWith("Python");
      const args = cli
        ? [
            path.join(root, "packages/coremind-cli/dist/cli.js"),
            "run",
            config,
            "--prompt",
            prompt,
            "--json-events",
          ]
        : python
          ? ["-B", "-X", "utf8", path.join(example, "run.py"), config, prompt]
          : [path.join(example, "run.mjs"), config, prompt];
      if (entry === "Python Async SDK") args.push("--async");

      active = { case: scenario, calls, body, resources: resourceTexts, requests: 0 };
      const { stdout } = await exec(python ? COREMIND_SKILL_PYTHON : process.execPath, args, {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30_000,
      }).catch((error) => {
        throw new Error(
          `${entry} ${id} 执行失败：${error.stderr || error.stdout || error.message}`,
          {
            cause: active.error ?? error,
          },
        );
      });
      assert.equal(active.requests, calls.length + 1);
      let result = stdout.trim();
      if (cli) {
        const events = result.split("\n").map((line) => JSON.parse(line));
        assert.equal(events.find(({ type }) => type === "run_result")?.outcome.status, "succeeded");
        result = events
          .filter(({ type }) => type === "text_delta")
          .map(({ delta }) => delta)
          .join("");
      }
      const output = JSON.parse(result);
      assert.deepEqual(output, expected, `${entry} ${id} 的业务输出不匹配`);
      assert.deepEqual(
        Object.keys(output),
        Object.keys(expected),
        `${entry} ${id} 的输出字段顺序不匹配`,
      );
      await assert.rejects(stat(path.join(cwd, sentinel)), { code: "ENOENT" });
      if (skill) {
        await assert.rejects(stat(path.join(cwd, "skills", skill, "scripts", sentinel)), {
          code: "ENOENT",
        });
      }
      console.log(JSON.stringify({ entry, case: id, calls, output }));
    }
  }
} finally {
  if (provider.listening) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  await rm(workspace, { recursive: true, force: true });
}
