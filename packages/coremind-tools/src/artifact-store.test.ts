import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactStore,
  extractArtifactRecord,
  redactSecrets,
  wrapToolWithArtifactCapture,
} from "./artifact-store.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-artifacts-"));
}

function bashWithOutput(cwd: string, output: string) {
  const tool = createBashTool(cwd, {
    operations: {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from(output, "utf8"));
        return { exitCode: 0 };
      },
    },
  });
  return wrapToolWithArtifactCapture(tool, new ArtifactStore({ cwd }));
}

describe("ArtifactStore", () => {
  it("把大输出流式导入受控目录，并向模型提供头尾、摘要和引用", async () => {
    const cwd = workspace();
    const source = path.join(cwd, "source.log");
    const body = `HEAD-ERROR\n${"x".repeat(2 * 1024 * 1024)}\nTAIL-ERROR`;
    writeFileSync(source, body, "utf8");
    const store = new ArtifactStore({
      cwd,
      idFactory: () => "artifact-fixed",
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });

    const imported = await store.importFile(source, { deleteSource: true });

    expect(imported.record.status).toBe("stored");
    expect(imported.record.relativePath).toBe(".coremind/artifacts/artifact-fixed.log");
    expect(imported.record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.preview).toContain("HEAD-ERROR");
    expect(imported.preview).toContain("TAIL-ERROR");
    expect(imported.preview).toContain("Artifact: .coremind/artifacts/artifact-fixed.log");
    expect(readFileSync(path.join(cwd, imported.record.relativePath!), "utf8")).toBe(body);
  });

  it("拒绝工作区外 Artifact 根目录", () => {
    const cwd = workspace();
    expect(() => new ArtifactStore({ cwd, rootDir: path.dirname(cwd) })).toThrow(
      "Artifact 根目录必须位于工作区内",
    );
  });

  it("检测疑似凭据后不保留源文件、Artifact 或模型可见秘密", async () => {
    const cwd = workspace();
    const source = path.join(cwd, "secret.log");
    const secret = `sk-${"a".repeat(32)}`;
    writeFileSync(source, `before ${secret} after`, "utf8");
    const store = new ArtifactStore({ cwd, idFactory: () => "blocked" });

    const imported = await store.importFile(source, { deleteSource: true });

    expect(imported.record.status).toBe("blocked");
    expect(imported.record.relativePath).toBeUndefined();
    expect(imported.preview).not.toContain(secret);
    expect(() => readFileSync(source, "utf8")).toThrow();
    expect(() => readFileSync(path.join(cwd, ".coremind", "artifacts", "blocked.log"))).toThrow();
  });

  it("跨流式分块的凭据仍会被识别", async () => {
    const cwd = workspace();
    const source = path.join(cwd, "boundary-secret.log");
    const secret = `sk-${"c".repeat(32)}`;
    writeFileSync(source, `${"x".repeat(65_530)}${secret}`, "utf8");

    const imported = await new ArtifactStore({ cwd, idFactory: () => "boundary" }).importFile(
      source,
    );

    expect(imported.record.status).toBe("blocked");
    expect(imported.preview).not.toContain(secret);
  });

  it("包装工具后把外部临时路径替换为安全 Artifact 契约", async () => {
    const cwd = workspace();
    const source = path.join(tmpdir(), `pi-bash-${path.basename(cwd)}.log`);
    writeFileSync(source, `first\n${"m".repeat(80_000)}\ncritical-tail`, "utf8");
    const store = new ArtifactStore({ cwd, idFactory: () => "wrapped" });
    const tool = wrapToolWithArtifactCapture(
      {
        name: "bash",
        label: "bash",
        description: "test",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => ({
          content: [{ type: "text", text: `truncated. Full output: ${source}` }],
          details: { fullOutputPath: source },
          structuredContent: { output: "critical-tail", truncated: true, full_output_path: source },
        }),
      },
      store,
    );

    const result = await tool.execute("call-1", {});
    const record = extractArtifactRecord(result.details);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(record?.status).toBe("stored");
    expect(text).toContain("critical-tail");
    expect(JSON.stringify(result)).not.toContain(path.basename(source));
    expect(result.structuredContent).toMatchObject({ full_output_path: record?.relativePath });
    expect(existsSync(source)).toBe(false);
  });

  it("Bash 大输出被拦截后，结构化回执与进度均隐藏凭据", async () => {
    const cwd = workspace();
    const secret = `sk-${"z".repeat(32)}`;
    const tool = bashWithOutput(cwd, `${"示例行\n".repeat(8000)}${secret}\n`);
    const updates: unknown[] = [];
    const result = await tool.execute("blocked", { command: "fixture" }, undefined, (update) =>
      updates.push(update),
    );
    expect(extractArtifactRecord(result.details)?.status).toBe("blocked");
    expect(result.structuredContent).toMatchObject({ exit_code: 0, truncated: true });
    expect(JSON.stringify([result, updates])).not.toContain(secret);
  });

  it("Bash 完整输出保存失败时返回尾部和错误码，隐藏宿主临时路径", async () => {
    const cwd = workspace();
    const missingDir = path.join(cwd, "missing");
    const tool = bashWithOutput(cwd, `${"a".repeat(1_100_000)}尾部\n`);
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, missingDir);
    try {
      const result = await tool.execute("save-failed", { command: "fixture" });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("尾部") });
      expect(result.details).toMatchObject({ fullOutputError: "ENOENT" });
      expect(result.structuredContent).toMatchObject({
        output: expect.stringContaining("尾部"),
        exit_code: 0,
        truncated: true,
        full_output_error: "ENOENT",
      });
      expect(JSON.stringify(result)).not.toContain("pi-bash-");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("拒绝读取工具伪造的任意完整输出路径", async () => {
    const cwd = workspace();
    const source = path.join(cwd, "ordinary.txt");
    writeFileSync(source, "not a trusted tool temp file", "utf8");
    const tool = wrapToolWithArtifactCapture(
      {
        name: "custom",
        label: "custom",
        description: "test",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => ({
          content: [{ type: "text", text: source }],
          details: { fullOutputPath: source },
        }),
      },
      new ArtifactStore({ cwd }),
    );

    const result = await tool.execute("call-2", {});
    expect(existsSync(source)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(source);
  });

  it.skipIf(process.platform === "win32")("拒绝工具临时文件符号链接", async () => {
    const cwd = workspace();
    const target = path.join(cwd, "outside.log");
    const source = path.join(tmpdir(), `pi-output-${path.basename(cwd)}.log`);
    writeFileSync(target, "outside-content", "utf8");
    symlinkSync(target, source, "file");
    const tool = wrapToolWithArtifactCapture(
      {
        name: "custom",
        label: "custom",
        description: "test",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => ({
          content: [{ type: "text", text: source }],
          details: { fullOutputPath: source },
        }),
      },
      new ArtifactStore({ cwd }),
    );

    const result = await tool.execute("call-symlink", {});
    expect(extractArtifactRecord(result.details)).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("outside-content");
    expect(JSON.stringify(result)).not.toContain(source);
    expect(JSON.stringify(result)).not.toContain("outside-content");
  });

  it("拒绝通过临时目录链接读取非直接子文件", async () => {
    const cwd = workspace();
    const targetDirectory = workspace();
    const linkedDirectory = path.join(tmpdir(), `coremind-artifact-link-${path.basename(cwd)}`);
    const basename = `pi-output-${path.basename(cwd)}.log`;
    const target = path.join(targetDirectory, basename);
    const source = path.join(linkedDirectory, basename);
    writeFileSync(target, "linked-directory-content", "utf8");
    symlinkSync(
      targetDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const tool = wrapToolWithArtifactCapture(
      {
        name: "custom",
        label: "custom",
        description: "test",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => ({
          content: [{ type: "text", text: source }],
          details: { fullOutputPath: source },
        }),
      },
      new ArtifactStore({ cwd }),
    );

    const result = await tool.execute("call-directory-link", {});
    expect(extractArtifactRecord(result.details)).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("linked-directory-content");
    expect(JSON.stringify(result)).not.toContain(source);
    expect(JSON.stringify(result)).not.toContain("linked-directory-content");
  });

  it("50MB 输出保持有界模型预览并保留完整哈希文件", async () => {
    const cwd = workspace();
    const source = path.join(cwd, "fifty-megabytes.log");
    const descriptor = openSync(source, "w");
    const chunk = Buffer.alloc(1024 * 1024, "z");
    for (let index = 0; index < 50; index += 1) writeSync(descriptor, chunk);
    writeSync(descriptor, Buffer.from("\nCRITICAL-TAIL", "utf8"));
    closeSync(descriptor);

    const imported = await new ArtifactStore({ cwd, idFactory: () => "large" }).importFile(source);

    expect(imported.record.sizeBytes).toBe(50 * 1024 * 1024 + 14);
    expect(imported.preview.length).toBeLessThan(20_000);
    expect(imported.preview).toContain("CRITICAL-TAIL");
    expect(statSize(path.join(cwd, imported.record.relativePath!))).toBe(imported.record.sizeBytes);
  });

  it("普通工具文本中的秘密也会在返回模型前被遮蔽", () => {
    const secret = `sk-${"b".repeat(32)}`;
    expect(redactSecrets(`token=${secret}`)).toBe("token=[REDACTED]");
  });
});

function statSize(file: string): number {
  return statSync(file).size;
}
