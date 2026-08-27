/** 内置工具向 Agent 报告的可观察执行失败，不表示 Tool Adapter 边界失控。 */
export class ToolExecutionError extends Error {
  readonly code = "tool_execution_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolExecutionError";
  }
}

/** 进程已执行并正常返回非零退出码时，形成可由 Agent 观察的已登记工具失败。 */
export function commandExecutionError(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): ToolExecutionError {
  const output = `${result.stdout}${result.stderr}`.trim() || "(no output)";
  return new ToolExecutionError(`${output}\n\nCommand exited with code ${result.exitCode}`);
}
