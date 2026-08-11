import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type ArtifactStatus = "stored" | "blocked";

export interface ArtifactRecord {
  artifactId: string;
  status: ArtifactStatus;
  relativePath?: string;
  sizeBytes: number;
  sha256?: string;
  mediaType: string;
  createdAt: string;
  retention: "run";
  redaction: "none" | "blocked-secret";
}

export interface ArtifactImportResult {
  record: ArtifactRecord;
  preview: string;
}

export interface ArtifactStoreOptions {
  cwd: string;
  rootDir?: string;
  idFactory?: () => string;
  now?: () => Date;
  previewBytes?: number;
}

/**
 * 把完整工具输出保存在工作区受控目录；模型只读取固定大小的头尾预览。
 * Artifact 文件名由框架生成，调用方不能借此写入任意路径。
 */
export class ArtifactStore {
  private readonly cwd: string;
  private readonly rootDir: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly previewBytes: number;

  constructor(options: ArtifactStoreOptions) {
    this.cwd = path.resolve(options.cwd);
    this.rootDir = path.resolve(options.rootDir ?? path.join(this.cwd, ".coremind", "artifacts"));
    if (!isStrictChild(this.cwd, this.rootDir)) {
      throw new Error("Artifact 根目录必须位于工作区内");
    }
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.previewBytes = options.previewBytes ?? 8 * 1024;
    if (!Number.isInteger(this.previewBytes) || this.previewBytes < 256) {
      throw new Error("previewBytes 必须是至少 256 的整数");
    }
  }

  async importFile(
    sourcePath: string,
    options: { deleteSource?: boolean; mediaType?: string } = {},
  ): Promise<ArtifactImportResult> {
    const source = path.resolve(sourcePath);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("Artifact 来源必须是普通文件");
    const artifactId = this.idFactory();
    if (!/^[A-Za-z0-9_-]+$/.test(artifactId)) {
      throw new Error("Artifact id 只能包含字母、数字、下划线和连字符");
    }
    await this.ensureRoot();
    const destination = path.join(this.rootDir, `${artifactId}.log`);
    const staging = path.join(this.rootDir, `.${artifactId}.tmp`);
    const hash = createHash("sha256");
    let containsSecret = false;
    let scanCarry = "";
    let sizeBytes = 0;
    const scanner = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        hash.update(chunk);
        const text = `${scanCarry}${chunk.toString("utf8")}`;
        if (containsSecretText(text)) containsSecret = true;
        scanCarry = text.slice(-512);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        createReadStream(source),
        scanner,
        createWriteStream(staging, { flags: "wx" }),
      );
      if (containsSecret) {
        await rm(staging, { force: true });
        return {
          record: {
            artifactId,
            status: "blocked",
            sizeBytes,
            mediaType: options.mediaType ?? "text/plain; charset=utf-8",
            createdAt: this.now().toISOString(),
            retention: "run",
            redaction: "blocked-secret",
          },
          preview:
            "[工具输出包含疑似凭据，已从模型上下文移除且未保存 Artifact；请在本地安全环境中重新执行并检查。]",
        };
      }

      await rename(staging, destination);
      const relativePath = toPortablePath(path.relative(this.cwd, destination));
      const record: ArtifactRecord = {
        artifactId,
        status: "stored",
        relativePath,
        sizeBytes,
        sha256: hash.digest("hex"),
        mediaType: options.mediaType ?? "text/plain; charset=utf-8",
        createdAt: this.now().toISOString(),
        retention: "run",
        redaction: "none",
      };
      return { record, preview: await this.buildPreview(destination, record) };
    } finally {
      await rm(staging, { force: true }).catch(() => {});
      if (options.deleteSource && source !== destination) {
        await rm(source, { force: true }).catch(() => {});
      }
    }
  }

  /** 只清理受控目录内、超过指定保留时间的框架生成日志。 */
  async cleanup(olderThanMs: number): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error("olderThanMs 必须是非负数");
    }
    await this.ensureRoot();
    const cutoff = this.now().getTime() - olderThanMs;
    let removed = 0;
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.log$/.test(entry.name)) continue;
      const candidate = path.join(this.rootDir, entry.name);
      const metadata = await stat(candidate);
      if (metadata.mtimeMs > cutoff) continue;
      await rm(candidate, { force: true });
      removed += 1;
    }
    return removed;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const [workspaceReal, rootReal] = await Promise.all([
      realpath(this.cwd),
      realpath(this.rootDir),
    ]);
    if (!isStrictChild(workspaceReal, rootReal)) {
      throw new Error("Artifact 根目录解析后越出工作区");
    }
  }

  private async buildPreview(filePath: string, record: ArtifactRecord): Promise<string> {
    const handle = await open(filePath, "r");
    try {
      const headSize = Math.min(this.previewBytes, record.sizeBytes);
      const tailSize = Math.min(this.previewBytes, Math.max(0, record.sizeBytes - headSize));
      const head = Buffer.alloc(headSize);
      const tail = Buffer.alloc(tailSize);
      await handle.read(head, 0, headSize, 0);
      if (tailSize > 0) {
        await handle.read(tail, 0, tailSize, record.sizeBytes - tailSize);
      }
      const omitted = Math.max(0, record.sizeBytes - headSize - tailSize);
      const sections = [
        `[工具输出已截断：共 ${record.sizeBytes} 字节，模型上下文省略 ${omitted} 字节]`,
        `--- 开头 ${headSize} 字节 ---\n${redactSecrets(head.toString("utf8"))}`,
      ];
      if (tailSize > 0) {
        sections.push(`--- 结尾 ${tailSize} 字节 ---\n${redactSecrets(tail.toString("utf8"))}`);
      }
      sections.push(
        `[Artifact: ${record.relativePath}; sha256=${record.sha256}; mediaType=${record.mediaType}; retention=${record.retention}]`,
      );
      return sections.join("\n\n");
    } finally {
      await handle.close();
    }
  }
}

/** 把依赖工具的外部临时文件适配为 CoreMind 的受控 Artifact 契约。 */
export function wrapToolWithArtifactCapture(tool: AgentTool, store: ArtifactStore): AgentTool {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const safeUpdate = onUpdate
        ? (partial: AgentToolResult<unknown>) => onUpdate(sanitizeResult(partial))
        : undefined;
      const result = await execute(toolCallId, params, signal, safeUpdate);
      const fullOutputPath = readFullOutputPath(result.details);
      if (!fullOutputPath) return sanitizeResult(result);
      if (!isTrustedTemporaryOutputPath(fullOutputPath)) {
        const sanitized = sanitizeResult(result);
        return {
          ...sanitized,
          content: [
            ...sanitized.content,
            { type: "text", text: "[已丢弃不受信任的外部完整输出路径。]" },
          ],
        };
      }
      const imported = await store.importFile(fullOutputPath, { deleteSource: true });
      return {
        ...result,
        content: [{ type: "text", text: imported.preview }],
        details: {
          ...(isRecord(result.details) ? result.details : {}),
          fullOutputPath: undefined,
          artifact: imported.record,
        },
      };
    },
  };
}

export function extractArtifactRecord(details: unknown): ArtifactRecord | undefined {
  if (!isRecord(details) || !isRecord(details.artifact)) return undefined;
  const artifact = details.artifact;
  return typeof artifact.artifactId === "string" &&
    (artifact.status === "stored" || artifact.status === "blocked") &&
    typeof artifact.sizeBytes === "number"
    ? (artifact as unknown as ArtifactRecord)
    : undefined;
}

export function redactSecrets(text: string): string {
  return text
    .replace(
      /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})/g,
      "[REDACTED]",
    )
    .replace(
      /((?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY)\s*[=:]\s*)[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

function containsSecretText(text: string): boolean {
  return (
    /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})/.test(
      text,
    ) ||
    /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY)\s*[=:]\s*[^\s"']+/i.test(text) ||
    /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{12,}/i.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  );
}

function sanitizeResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  const fullOutputPath = readFullOutputPath(result.details);
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === "text"
        ? {
            ...item,
            text: redactSecrets(
              fullOutputPath
                ? item.text.replaceAll(fullOutputPath, "[受控 Artifact 待生成]")
                : item.text,
            ),
          }
        : item,
    ),
    details: stripExternalOutputPath(result.details),
  };
}

function stripExternalOutputPath<T>(details: T): T {
  if (!isRecord(details) || !("fullOutputPath" in details)) return details;
  return { ...details, fullOutputPath: undefined } as T;
}

function readFullOutputPath(details: unknown): string | undefined {
  return isRecord(details) && typeof details.fullOutputPath === "string"
    ? details.fullOutputPath
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isTrustedTemporaryOutputPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const temporaryRoot = path.resolve(tmpdir());
  const basename = path.basename(resolved);
  return (
    isStrictChild(temporaryRoot, resolved) &&
    /^(?:pi-bash|pi-output)-[A-Za-z0-9_-]+\.log$/.test(basename)
  );
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}
