/** 临时授权交互；标准 state/challenge 仅存在于授权 URL，凭据不进入此合同。 */
export interface McpAuthorizationRequest {
  readonly transactionId: string;
  readonly server: string;
  readonly serverIdentity: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
}

export type McpAuthorizationHandler = (
  request: McpAuthorizationRequest,
  signal: AbortSignal,
) => void | Promise<void>;

export interface McpLoginOptions {
  transactionId?: string;
  signal?: AbortSignal;
  onAuthorization?: McpAuthorizationHandler;
}

export interface McpAuthenticationResult {
  readonly status: "authorized";
  readonly transactionId: string;
  readonly server: string;
  readonly serverIdentity: string;
}

/** 仅供明确注入的宿主安全存储使用；禁止通过 Worker、事件或日志序列化。 */
export interface McpTokenRecord {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly serverIdentity: string;
  readonly resource: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly tokenType: "Bearer";
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

export interface McpTokenStore {
  load(key: string, signal?: AbortSignal): Promise<McpTokenRecord | undefined>;
  save(key: string, record: McpTokenRecord, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export interface McpAuthentication {
  login(server: string, options?: McpLoginOptions): Promise<McpAuthenticationResult>;
  logout(server: string): Promise<void>;
  close(): Promise<void>;
}
