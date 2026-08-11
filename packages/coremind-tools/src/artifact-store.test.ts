import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  extractArtifactRecord,
  redactSecrets,
  wrapToolWithArtifactCapture,
} from "./artifact-store.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-artifacts-"));
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
        }),
      },
      store,
    );

    const result = await tool.execute("call-1", {});
    const record = extractArtifactRecord(result.details);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(record?.status).toBe("stored");
    expect(text).toContain("critical-tail");
    expect(text).not.toContain(source);
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
