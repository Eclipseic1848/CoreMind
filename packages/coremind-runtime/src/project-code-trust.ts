import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";

export interface ProjectCodeTrustRequest {
  projectRoot: string;
  sources: readonly { path: string; sha256: string }[];
  fingerprint: string;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CoreMindError("aborted", "项目代码加载已取消");
}

/** 仅识别入口文件；传递依赖和同权限外部修改不属于不可变性保证。 */
async function inspectSource(fullPath: string, signal?: AbortSignal) {
  checkCancellation(signal);
  const canonical = await realpath(fullPath);
  if (!(await stat(canonical)).isFile()) {
    throw new CoreMindError("execution_security_violation", "项目脚本入口必须是普通文件");
  }
  const handle = await open(canonical, "r");
  try {
    if (!(await handle.stat()).isFile()) {
      throw new CoreMindError("execution_security_violation", "项目脚本入口必须是普通文件");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      hash.update(chunk);
    }
    checkCancellation(signal);
    return { path: canonical, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** 首次 import 前单批批准；每次真实 import 边界重新确认入口范围。 */
export async function prepareProjectCodeImports(
  config: CoreMindConfig,
  configDir: string,
  approve:
    | ((request: ProjectCodeTrustRequest, signal?: AbortSignal) => boolean | Promise<boolean>)
    | undefined,
  signal?: AbortSignal,
): Promise<((fullPath: string) => Promise<string>) | undefined> {
  const entries = [
    ...new Set(
      Object.values(config.agents).flatMap((agent) =>
        (((agent.tools?.length ?? 0) > 0 ? agent.tools : config.tools) ?? []).flatMap((tool) =>
          "path" in tool ? [path.resolve(configDir, tool.path)] : [],
        ),
      ),
    ),
  ];
  if (entries.length === 0) return undefined;
  const approved = new Map<string, { path: string; sha256: string }>();
  for (const entry of entries) {
    try {
      approved.set(entry, await inspectSource(entry, signal));
    } catch (error) {
      checkCancellation(signal);
      // 缺失入口仍由原加载器报告；之后出现的新文件不能取得本批批准。
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw new CoreMindError("execution_security_violation", "无法确认项目脚本入口");
    }
  }
  if (approved.size > 0) {
    const byPath = new Map<string, { path: string; sha256: string }>();
    for (const source of approved.values()) {
      const previous = byPath.get(source.path);
      if (previous && previous.sha256 !== source.sha256) {
        throw new CoreMindError("execution_security_violation", "准备批准范围期间项目脚本发生变化");
      }
      byPath.set(source.path, source);
    }
    const sources = [...byPath.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const scope = { projectRoot: await realpath(configDir), sources };
    const request = {
      ...scope,
      fingerprint: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
    };
    let accepted = false;
    try {
      checkCancellation(signal);
      accepted = (await approve?.(structuredClone(request), signal)) === true;
    } catch {
      checkCancellation(signal);
      throw new CoreMindError("execution_security_violation", "宿主未批准加载项目脚本");
    }
    checkCancellation(signal);
    if (!accepted)
      throw new CoreMindError("execution_security_violation", "加载项目脚本需要宿主明确批准");
  }
  return async (fullPath) => {
    checkCancellation(signal);
    let current: { path: string; sha256: string };
    try {
      current = await inspectSource(fullPath, signal);
    } catch (error) {
      checkCancellation(signal);
      throw error;
    }
    const original = approved.get(fullPath);
    if (!original || original.path !== current.path || original.sha256 !== current.sha256) {
      throw new CoreMindError(
        "execution_security_violation",
        "项目脚本入口已变化，必须重新取得加载批准",
      );
    }
    return current.path;
  };
}
