import {
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  type ProtocolV2InitializeResult,
  type ProtocolV2SessionRequest,
  type ProtocolV2SessionResult,
  type ProtocolV2TaskRequest,
  type ProtocolV2TaskResult,
  ProtocolV2ValidationError,
  parseProtocolV2Request,
  parseProtocolV2SessionResult,
  parseProtocolV2TaskResult,
} from "./v2.js";

type BoundCommand<T> = T extends unknown ? Omit<T, "sessionId"> : never;

/** 复用宿主已有 RPC 传输；只封装绑定会话的新 v2 操作，不建立第二执行器。 */
export class ProtocolV2SessionClient {
  private readonly capabilities: ReadonlySet<string>;
  private readonly sessionId: string;
  private readonly request: (
    method: "task" | "session",
    params: ProtocolV2TaskRequest["params"] | ProtocolV2SessionRequest["params"],
  ) => Promise<unknown>;

  constructor(options: {
    sessionId: string;
    initialized: ProtocolV2InitializeResult;
    request: (
      method: "task" | "session",
      params: ProtocolV2TaskRequest["params"] | ProtocolV2SessionRequest["params"],
    ) => Promise<unknown>;
  }) {
    if (
      options.initialized.selectedProtocol !== "2.0" ||
      options.initialized.schemaFingerprint !== PROTOCOL_V2_SCHEMA_FINGERPRINT
    )
      throw Object.assign(new ProtocolV2ValidationError("Protocol v2 Schema 指纹不匹配"), {
        code: "protocol_version_mismatch",
      });
    this.sessionId = options.sessionId;
    this.capabilities = new Set(options.initialized.serverCapabilities);
    this.request = options.request;
  }

  async task(
    command: BoundCommand<ProtocolV2TaskRequest["params"]>,
  ): Promise<ProtocolV2TaskResult> {
    this.require("durableTasks");
    const params = { ...command, sessionId: this.sessionId };
    parseProtocolV2Request({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "validate",
      method: "task",
      params,
    });
    return parseProtocolV2TaskResult(await this.invoke("task", params), params);
  }

  async session(
    command: BoundCommand<ProtocolV2SessionRequest["params"]>,
  ): Promise<ProtocolV2SessionResult> {
    this.require("sessionBranches");
    const params = { ...command, sessionId: this.sessionId };
    parseProtocolV2Request({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "validate",
      method: "session",
      params,
    });
    return parseProtocolV2SessionResult(await this.invoke("session", params), params);
  }

  private async invoke(
    method: "task" | "session",
    params: ProtocolV2TaskRequest["params"] | ProtocolV2SessionRequest["params"],
  ): Promise<unknown> {
    try {
      return await this.request(method, params);
    } catch (error) {
      const details = (error as { data?: { details?: Record<string, unknown> } } | null)?.data
        ?.details;
      if (
        details &&
        typeof details === "object" &&
        "operation" in details &&
        (details.operation !== method ||
          details.sessionId !== params.sessionId ||
          details.action !== params.action ||
          ("taskId" in params && details.taskId !== params.taskId))
      )
        throw new ProtocolV2ValidationError("任务或会话错误响应身份不匹配");
      throw error;
    }
  }

  private require(capability: string): void {
    if (!this.capabilities.has(capability))
      throw Object.assign(new ProtocolV2ValidationError("Worker 未协商 " + capability), {
        code: "protocol_capability_missing",
      });
  }
}
