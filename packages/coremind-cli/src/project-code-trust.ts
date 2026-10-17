import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { CoreMindError, type CoreMindRuntimeOptions } from "coremind-ai";
import type { ParsedArgs } from "./args.js";
import { terminalText } from "./render.js";

/** 每个命令进程只记住完整范围的本次决定，永不从项目配置授予信任。 */
export function createProjectCodeAuthorizer(
  parsed: ParsedArgs,
  onInterrupt?: () => void,
): NonNullable<CoreMindRuntimeOptions["approveProjectCode"]> {
  const value = parsed.flags.get("trust-project-code");
  if (
    value !== undefined &&
    value !== true &&
    value !== false &&
    value !== "true" &&
    value !== "false"
  ) {
    throw new Error("--trust-project-code 只能是 true 或 false");
  }
  const decisions = new Map<string, boolean>();
  return async (request, signal) => {
    signal?.throwIfAborted();
    if (value === true || value === "true") return true;
    if (value === false || value === "false" || stdin.isTTY !== true) return false;
    const previous = decisions.get(request.fingerprint);
    if (previous !== undefined) return previous;
    const controller = new AbortController();
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      onInterrupt?.();
      controller.abort();
    };
    const closeInput = () => controller.abort();
    const reader = createInterface({ input: stdin, output: stderr });
    reader.once("SIGINT", interrupt);
    reader.once("close", closeInput);
    process.once("SIGINT", interrupt);
    try {
      stderr.write(`项目：${terminalText(request.projectRoot)}\n`);
      for (const source of request.sources)
        stderr.write(`  ${terminalText(source.path)} [sha256:${source.sha256}]\n`);
      const answer = await reader.question(
        "加载上述脚本及其依赖会以宿主权限执行顶层代码；工具执行仍需独立授权。是否信任？[y/N] ",
        {
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        },
      );
      if (interrupted || signal?.aborted) throw new CoreMindError("aborted", "项目代码加载已取消");
      const accepted = /^(?:y|yes)$/iu.test(answer.trim());
      decisions.set(request.fingerprint, accepted);
      return accepted;
    } catch {
      if (interrupted || signal?.aborted) throw new CoreMindError("aborted", "项目代码加载已取消");
      decisions.set(request.fingerprint, false);
      return false;
    } finally {
      reader.off("SIGINT", interrupt);
      reader.off("close", closeInput);
      process.off("SIGINT", interrupt);
      reader.close();
    }
  };
}
