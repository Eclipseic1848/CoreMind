/** CoreMind 运行时错误（带错误码，便于 CLI 与库调用方区分处理） */
export class CoreMindError extends Error {
  /** 机器可读错误码：unknown_provider / no_models / unknown_agent / step_limit / ... */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoreMindError";
    this.code = code;
  }
}
