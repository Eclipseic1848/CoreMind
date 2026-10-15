/** 稳定错误不携带 SDK、进程环境、stderr 或远端原文。 */
export class McpStdioError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpStdioError";
  }
}
