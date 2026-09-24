import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const fileTools = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const bindings = new WeakMap<object, { tool: string; input: string; target: string }>();

/** 对齐锁定的 Pi 文件工具路径语义；审批和执行共用同一目标绑定。 */
export async function resolveFileToolTarget(
  tool: string,
  args: unknown,
  cwd: string,
): Promise<string | undefined> {
  if (!fileTools.has(tool) || !args || typeof args !== "object") return undefined;
  const input = (args as { path?: unknown }).path;
  if (input !== undefined && typeof input !== "string") return undefined;
  if (input === undefined && ["read", "write", "edit"].includes(tool)) return undefined;
  const raw = input ?? ".";
  let normalized = raw.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !normalized.includes("\\")) {
    normalized = normalized.replace(
      /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_match, drive, rest) => `${drive}:/${rest ?? ""}`,
    );
  }
  if (normalized === "~") normalized = homedir();
  else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  )
    normalized = path.join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  let target = path.resolve(cwd, normalized);
  if (tool === "read") {
    const variants = [
      target,
      target.replace(/ (AM|PM)\./gi, "\u202f$1."),
      target.normalize("NFD"),
      target.replace(/'/g, "\u2019"),
      target.normalize("NFD").replace(/'/g, "\u2019"),
    ];
    for (const variant of variants) {
      try {
        await access(variant);
        target = variant;
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
  }
  target = await canonicalFileTarget(target);
  const previous = bindings.get(args);
  if (
    previous &&
    (previous.tool !== tool || previous.input !== raw || previous.target !== target)
  ) {
    throw new Error("文件目标在审批或执行期间发生变化，必须重新发起调用");
  }
  bindings.set(args, { tool, input: raw, target });
  return target;
}

async function canonicalFileTarget(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(await canonicalFileTarget(parent), path.basename(input));
  }
}

/** 执行前重新核对绑定；上游只接收已授权目标，不再解释原始别名。 */
export function bindFileToolTarget(tool: AgentTool, cwd: string): AgentTool {
  if (!fileTools.has(tool.name)) return tool;
  return {
    ...tool,
    execute: async (callId, args, signal, onUpdate) => {
      const target = await resolveFileToolTarget(tool.name, args, cwd);
      if (target === undefined) return tool.execute(callId, args, signal, onUpdate);
      const resolvedArgs = { ...(args as Record<string, unknown>), path: target };
      // 规范化真实名称后若上游还会重新解释，拒绝而不是改换目标。
      if ((await resolveFileToolTarget(tool.name, resolvedArgs, cwd)) !== target) {
        throw new Error("文件真实路径无法无歧义地交给上游工具");
      }
      return tool.execute(callId, resolvedArgs, signal, onUpdate);
    },
  };
}
