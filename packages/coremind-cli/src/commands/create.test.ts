import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findTemplate, loadConfigFile, parseAndValidate, TEMPLATES } from "coremind-ai";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../args.js";
import { cmdCreate, environmentCopyCommand } from "./create.js";

describe("create 跨平台引导", () => {
  it("Windows 使用 PowerShell 命令，Linux 使用 POSIX 命令", () => {
    expect(environmentCopyCommand("win32")).toBe("Copy-Item .env.example .env");
    expect(environmentCopyCommand("linux")).toBe("cp .env.example .env");
  });
});

const cloudflareModel = "@cf/deepseek-ai/deepseek-v4-flash-0731";

function createProject(target: string, template: string, model: string) {
  const args = parseArgs([
    target,
    "--template",
    template,
    "--language",
    "typescript",
    "--provider",
    "cloudflare-workers-ai",
    "--api-key-env",
    "CLOUDFLARE_API_KEY",
    "--model",
    model,
  ]);
  return cmdCreate(args, args.positionals);
}

it("模板按所选供应商写入 @cf 模型，保留模板 Agent 和已有配置", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "coremind-create-model-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "project");
  const yaml = path.join(target, "coremind.yaml");
  expect(await createProject(target, "translator", cloudflareModel)).toBe(0);
  const { config } = parseAndValidate(await loadConfigFile(yaml));
  expect(config.provider).toEqual({
    id: "cloudflare-workers-ai",
    model: cloudflareModel,
    apiKeyEnv: "CLOUDFLARE_API_KEY",
  });
  expect(config.agents.translator).toBeDefined();
  const original = await readFile(yaml, "utf8");
  expect(await createProject(target, "translator", "another-model")).toBe(0);
  expect(await readFile(yaml, "utf8")).toBe(original);
});

it("生成配置校验失败后，可在原有工程中用相同参数重试", async (context) => {
  const target = await mkdtemp(path.join(tmpdir(), "coremind-create-retry-"));
  const templateDir = await mkdtemp(path.join(tmpdir(), "coremind-create-template-"));
  const template = { ...findTemplate("translator")!, id: "retry-template", dir: templateDir };
  TEMPLATES.push(template);
  context.onTestFinished(async () => {
    TEMPLATES.splice(TEMPLATES.indexOf(template), 1);
    await Promise.all(
      [target, templateDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  const source = path.join(templateDir, "coremind.yaml");
  const valid = await readFile(path.join(findTemplate("translator")!.dir, "coremind.yaml"), "utf8");
  await writeFile(source, valid.replace("schemaVersion: 2", "schemaVersion: 999"), "utf8");
  await writeFile(path.join(target, "user.txt"), "原有内容", "utf8");
  const run = () => createProject(target, template.id, "model-$&");
  expect(await run()).toBe(1);
  expect(await readdir(target)).toEqual(["user.txt"]);

  await writeFile(source, valid, "utf8");
  expect(await run()).toBe(0);
  const { config } = parseAndValidate(await loadConfigFile(path.join(target, "coremind.yaml")));
  expect(config.provider).toMatchObject({ id: "cloudflare-workers-ai", model: "model-$&" });
  expect(await readFile(path.join(target, "user.txt"), "utf8")).toBe("原有内容");
});
