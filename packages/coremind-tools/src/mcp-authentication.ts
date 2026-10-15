import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/client";
import type { McpHttpServerConfig } from "coremind-config";
import type { ExecutionEnvironment } from "./execution-environment.js";
import type {
  McpAuthentication,
  McpAuthenticationResult,
  McpAuthorizationRequest,
  McpLoginOptions,
  McpTokenRecord,
  McpTokenStore,
} from "./mcp-authentication-types.js";
import { createMcpHttpFetch, type McpHttpFetchOwner } from "./mcp-http-fetch.js";
import { McpStdioError } from "./mcp-stdio-transport.js";
import { createPlatformExecutionEnvironment } from "./platform-execution-environment.js";

const LOGIN_MS = 180_000;
const REQUEST_MS = 30_000;
const CLOSE_MS = 5_000;
const MAX_JSON = 64 * 1024;
export const MCP_AUTH_MAX_SECRET_LENGTH = 16 * 1024;

export interface McpAuthenticationServer {
  readonly server: string;
  readonly config: McpHttpServerConfig;
  readonly serverIdentity: string;
}
export interface McpAuthenticationEngineOptions {
  readonly servers: readonly McpAuthenticationServer[];
  readonly network: "allow" | "ask" | "deny";
  readonly tokenStore?: McpTokenStore;
  readonly namespace?: string;
}
/** 仅供同仓网络 owner 使用；公共 session 不暴露令牌和内部方法。 */
export interface McpAuthenticationBinding {
  readonly signal: AbortSignal;
  readonly maxSecretLength: number;
  authorize(signal?: AbortSignal): Promise<string>;
  assertActive(): void;
  assertSafe(text: string): void;
}
interface RefreshFlight {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}
interface State {
  entry: McpAuthenticationServer;
  key: string;
  epoch: number;
  controller: AbortController;
  record?: McpTokenRecord;
  loaded: boolean;
  loading?: Promise<void>;
  refresh?: RefreshFlight;
  login?: Promise<McpAuthenticationResult>;
  metadata?: AuthorizationServerMetadata;
  queue: Promise<unknown>;
  generations: number;
  secrets: Set<string>;
}
const engines = new WeakMap<McpAuthentication, AuthenticationEngine>();

export function createMcpAuthenticationEngine(
  options: McpAuthenticationEngineOptions,
): McpAuthentication {
  const engine = new AuthenticationEngine(options);
  const session: McpAuthentication = Object.freeze({
    login: (server: string, login?: McpLoginOptions) => engine.login(server, login),
    logout: (server: string) => engine.logout(server),
    close: () => engine.close(),
  });
  engines.set(session, engine);
  return session;
}
export function bindMcpAuthentication(
  session: McpAuthentication,
  server: string,
  identity: string,
  _environment?: ExecutionEnvironment,
): McpAuthenticationBinding {
  const engine = engines.get(session);
  if (!engine) throw failed();
  return engine.bind(server, identity);
}

class AuthenticationEngine {
  private readonly states = new Map<string, State>();
  private readonly namespace: string;
  private readonly store: McpTokenStore;
  private readonly memory = new Map<string, McpTokenRecord>();
  private readonly controller = new AbortController();
  private readonly owners = new Set<McpHttpFetchOwner>();
  private readonly callbacks = new Set<() => Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly transactions = new Set<string>();
  private environment?: ExecutionEnvironment;
  private closing?: Promise<void>;

  constructor(private readonly options: McpAuthenticationEngineOptions) {
    if (options.tokenStore && (!options.namespace?.trim() || options.namespace.length > 256))
      throw failed();
    this.namespace = options.namespace ?? randomUUID();
    this.store = options.tokenStore ?? {
      load: async (key) => this.memory.get(key),
      save: async (key, record) => {
        this.memory.set(key, structuredClone(record));
      },
      delete: async (key) => {
        this.memory.delete(key);
      },
    };
    for (const entry of options.servers) {
      if (this.states.has(entry.server) || !entry.config.oauth) throw failed();
      const snapshot = structuredClone(entry);
      const oauth = snapshot.config.oauth!;
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            this.namespace,
            entry.serverIdentity,
            new URL(entry.config.url).href,
            oauth.issuer,
            oauth.clientId,
            [...oauth.scopes].sort(),
          ]),
          "utf8",
        )
        .digest("hex");
      this.states.set(entry.server, {
        entry: snapshot,
        key,
        epoch: 0,
        controller: new AbortController(),
        loaded: false,
        queue: Promise.resolve(),
        generations: 0,
        secrets: new Set(),
      });
    }
  }

  bind(server: string, identity: string): McpAuthenticationBinding {
    const state = this.state(server);
    if (state.entry.serverIdentity !== identity) throw failed();
    const epoch = state.epoch;
    const signal = state.controller.signal;
    const assertActive = () => this.active(state, epoch);
    return {
      signal,
      assertActive,
      maxSecretLength: MCP_AUTH_MAX_SECRET_LENGTH,
      authorize: (caller) => this.authorize(state, epoch, caller),
      assertSafe: (text) => {
        assertActive();
        if ([...state.secrets].some((value) => text.includes(value)))
          throw new McpStdioError("mcp_secret_blocked", "MCP 响应包含受保护凭据");
      },
    };
  }

  login(server: string, options: McpLoginOptions = {}): Promise<McpAuthenticationResult> {
    if (typeof options.onAuthorization !== "function") return Promise.reject(required());
    if (this.options.network === "deny") return Promise.reject(failed());
    if (options.signal?.aborted) return Promise.reject(aborted());
    let state: State;
    try {
      state = this.state(server);
    } catch (error) {
      return Promise.reject(error);
    }
    const transactionId = options.transactionId ?? randomUUID();
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(transactionId) ||
      this.transactions.has(transactionId) ||
      this.transactions.size >= 256 ||
      state.login
    )
      return Promise.reject(failed());
    this.transactions.add(transactionId);
    this.revoke(state);
    state.generations = 0;
    state.secrets.clear();
    const epoch = state.epoch;
    const transaction = new AbortController();
    const signal = AbortSignal.any([
      transaction.signal,
      this.controller.signal,
      state.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const expiresAt = Date.now() + LOGIN_MS;
    const timer = setTimeout(
      () => transaction.abort(new McpStdioError("run_timeout", "MCP 授权事务超时")),
      LOGIN_MS,
    );
    const promise = this.track(
      (async () => {
        try {
          const metadata = await this.discover(state, signal);
          const callback = await this.callback(state, metadata, signal);
          try {
            const { startAuthorization, exchangeAuthorization } = await import(
              "@modelcontextprotocol/client"
            );
            const oauth = state.entry.config.oauth!;
            const authorization = await startAuthorization(oauth.issuer, {
              metadata,
              clientInformation: { client_id: oauth.clientId, token_endpoint_auth_method: "none" },
              redirectUrl: callback.url,
              state: callback.state,
              scope: oauth.scopes.join(" "),
              resource: new URL(state.entry.config.url).href,
            });
            if (signal.aborted) throw safeError(undefined, signal);
            this.active(state, epoch);
            const request: McpAuthorizationRequest = Object.freeze({
              transactionId,
              server,
              serverIdentity: state.entry.serverIdentity,
              authorizationUrl: authorization.authorizationUrl.href,
              expiresAt: new Date(expiresAt).toISOString(),
              issuer: oauth.issuer,
              clientId: oauth.clientId,
              resource: new URL(state.entry.config.url).href,
              scopes: Object.freeze([...oauth.scopes]),
            });
            const handler = this.track(
              Promise.resolve().then(() => {
                if (signal.aborted) throw safeError(undefined, signal);
                this.active(state, epoch);
                return options.onAuthorization!(request, signal);
              }),
            );
            const [code] = await Promise.all([wait(callback.code, signal), wait(handler, signal)]);
            this.active(state, epoch);
            const tokens = await exchangeAuthorization(oauth.issuer, {
              metadata,
              clientInformation: { client_id: oauth.clientId, token_endpoint_auth_method: "none" },
              authorizationCode: code.code,
              iss: code.issuer,
              codeVerifier: authorization.codeVerifier,
              redirectUri: callback.url,
              resource: new URL(state.entry.config.url).href,
              fetchFn: (input, init) => this.request(state, String(input), init, signal, true),
            });
            await this.publish(state, epoch, this.tokenRecord(state, tokens), signal);
            return {
              status: "authorized" as const,
              transactionId,
              server,
              serverIdentity: state.entry.serverIdentity,
            };
          } finally {
            await callback.close();
          }
        } catch (cause) {
          const error = safeError(cause, signal);
          if (state.epoch === epoch) this.revoke(state);
          throw error;
        } finally {
          clearTimeout(timer);
          transaction.abort();
        }
      })(),
    );
    state.login = promise;
    void promise
      .finally(() => {
        if (state.login === promise) state.login = undefined;
      })
      .catch(() => {});
    return promise;
  }

  async logout(server: string): Promise<void> {
    const state = this.state(server);
    const transactions = [state.login, state.refresh?.promise].filter(
      (value): value is Promise<McpAuthenticationResult> | Promise<string> => value !== undefined,
    );
    this.revoke(state);
    await this.storage(
      state,
      () => this.store.delete(state.key, this.controller.signal),
      this.controller.signal,
    );
    try {
      await wait(Promise.allSettled(transactions), AbortSignal.timeout(CLOSE_MS));
    } catch {
      throw storeFailed();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    for (const state of this.states.values()) this.revoke(state);
    this.memory.clear();
    this.closing = (async () => {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), CLOSE_MS);
      try {
        const cleanup = await wait(
          Promise.allSettled([
            ...[...this.owners].map((owner) => owner.close()),
            ...[...this.callbacks].map((close) => close()),
          ]),
          timer.signal,
        );
        if (cleanup.some((item) => item.status === "rejected")) throw storeFailed();
        await wait(Promise.allSettled([...this.pending]), timer.signal);
        if (this.pending.size) throw storeFailed();
      } catch {
        throw storeFailed();
      } finally {
        clearTimeout(timeout);
      }
      for (const state of this.states.values()) state.secrets.clear();
    })();
    return this.closing;
  }

  private state(server: string): State {
    if (this.closing || this.controller.signal.aborted) throw required();
    const state = this.states.get(server);
    if (!state) throw failed();
    return state;
  }
  private active(state: State, epoch: number): void {
    if (this.controller.signal.aborted || state.epoch !== epoch || state.controller.signal.aborted)
      throw required();
  }
  private revoke(state: State): void {
    state.controller.abort();
    state.epoch++;
    state.controller = new AbortController();
    state.record = undefined;
    state.loaded = true;
    state.loading = undefined;
    state.refresh = undefined;
  }

  private async authorize(state: State, epoch: number, caller?: AbortSignal): Promise<string> {
    if (caller?.aborted) throw aborted();
    this.active(state, epoch);
    if (this.options.network === "deny") throw failed();
    if (!state.loaded) {
      state.loading ??= this.track(
        (async () => {
          const value = await this.storage(
            state,
            () => this.store.load(state.key, state.controller.signal),
            state.controller.signal,
          );
          this.active(state, epoch);
          if (value !== undefined) {
            state.record = this.checkRecord(state, value);
            this.remember(state, state.record);
          }
          state.loaded = true;
        })(),
      );
      await wait(state.loading, caller);
    }
    this.active(state, epoch);
    if (caller?.aborted) throw aborted();
    const record = state.record;
    if (!record) throw required();
    if (record.expiresAt === undefined || record.expiresAt > Date.now()) return record.accessToken;
    if (!record.refreshToken) {
      this.revoke(state);
      throw required();
    }
    if (!state.refresh) {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        this.controller.signal,
        state.controller.signal,
        controller.signal,
      ]);
      const refresh = this.track(
        (async () => {
          try {
            const metadata = state.metadata ?? (await this.discover(state, signal));
            const { refreshAuthorization } = await import("@modelcontextprotocol/client");
            const oauth = state.entry.config.oauth!;
            const tokens = await refreshAuthorization(oauth.issuer, {
              metadata,
              clientInformation: { client_id: oauth.clientId, token_endpoint_auth_method: "none" },
              refreshToken: record.refreshToken!,
              resource: new URL(state.entry.config.url).href,
              fetchFn: (input, init) => this.request(state, String(input), init, signal, true),
            });
            const next = this.tokenRecord(state, tokens);
            await this.publish(state, epoch, next, signal);
            return next.accessToken;
          } catch (cause) {
            const error = safeError(cause, signal);
            if (state.epoch === epoch) this.revoke(state);
            throw error;
          }
        })(),
      );
      const flight = { controller, promise: refresh, waiters: 0 };
      state.refresh = flight;
      void refresh
        .finally(() => {
          if (state.refresh === flight) state.refresh = undefined;
        })
        .catch(() => {});
    }
    const flight = state.refresh;
    flight.waiters++;
    try {
      const token = await wait(flight.promise, caller);
      if (caller?.aborted) throw aborted();
      this.active(state, epoch);
      return token;
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && state.refresh === flight) flight.controller.abort();
    }
  }

  private async publish(
    state: State,
    epoch: number,
    record: McpTokenRecord,
    signal: AbortSignal,
  ): Promise<void> {
    this.active(state, epoch);
    this.remember(state, record);
    await this.storage(
      state,
      () => {
        this.active(state, epoch);
        return this.store.save(state.key, structuredClone(record), signal);
      },
      signal,
    );
    this.active(state, epoch);
    state.record = record;
    state.loaded = true;
  }
  private storage<T>(state: State, action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const operation = this.track(state.queue.then(action));
    state.queue = operation.catch(() => {});
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_MS);
    return wait(operation, AbortSignal.any([signal, deadline.signal]))
      .catch((cause) => {
        if (signal.aborted) throw safeError(cause, signal);
        this.revoke(state);
        throw storeFailed();
      })
      .finally(() => clearTimeout(timer));
  }
  private fields(state: State) {
    const oauth = state.entry.config.oauth!;
    return {
      schemaVersion: 1 as const,
      namespace: this.namespace,
      serverIdentity: state.entry.serverIdentity,
      resource: new URL(state.entry.config.url).href,
      issuer: oauth.issuer,
      clientId: oauth.clientId,
      scopes: [...oauth.scopes].sort(),
    };
  }
  private tokenRecord(state: State, tokens: OAuthTokens): McpTokenRecord {
    const scope =
      tokens.scope === undefined
        ? state.entry.config.oauth!.scopes
        : tokens.scope.split(" ").filter(Boolean);
    if (
      new Set(scope).size !== scope.length ||
      scope.some((value) => !state.entry.config.oauth!.scopes.includes(value)) ||
      tokens.token_type.toLowerCase() !== "bearer" ||
      !validSecret(tokens.access_token) ||
      (tokens.refresh_token !== undefined && !validSecret(tokens.refresh_token)) ||
      (tokens.expires_in !== undefined &&
        (!Number.isFinite(tokens.expires_in) ||
          tokens.expires_in < 0 ||
          !Number.isFinite(Date.now() + tokens.expires_in * 1000)))
    )
      throw failed();
    return {
      ...this.fields(state),
      scopes: [...scope].sort(),
      tokenType: "Bearer",
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.expires_in !== undefined
        ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
        : {}),
    };
  }
  private checkRecord(state: State, record: McpTokenRecord): McpTokenRecord {
    const expected = this.fields(state);
    if (
      !record ||
      typeof record !== "object" ||
      record.schemaVersion !== 1 ||
      record.namespace !== expected.namespace ||
      record.serverIdentity !== expected.serverIdentity ||
      record.resource !== expected.resource ||
      record.issuer !== expected.issuer ||
      record.clientId !== expected.clientId ||
      !Array.isArray(record.scopes) ||
      new Set(record.scopes).size !== record.scopes.length ||
      record.scopes.some((scope) => !expected.scopes.includes(scope)) ||
      record.tokenType !== "Bearer" ||
      !validSecret(record.accessToken) ||
      (record.refreshToken !== undefined && !validSecret(record.refreshToken)) ||
      (record.expiresAt !== undefined &&
        (!Number.isFinite(record.expiresAt) || record.expiresAt < 0))
    ) {
      this.revoke(state);
      throw storeFailed();
    }
    return structuredClone(record);
  }
  private remember(state: State, record: McpTokenRecord): void {
    if (state.generations >= 32) {
      this.revoke(state);
      throw required();
    }
    state.generations++;
    state.secrets.add(record.accessToken);
    if (record.refreshToken) state.secrets.add(record.refreshToken);
  }

  private async discover(state: State, signal: AbortSignal): Promise<AuthorizationServerMetadata> {
    const {
      discoverOAuthProtectedResourceMetadata,
      discoverAuthorizationServerMetadata,
      buildDiscoveryUrls,
    } = await import("@modelcontextprotocol/client");
    const config = state.entry.config;
    const oauth = config.oauth!;
    const resource = new URL(config.url);
    const resourceMetadataUrl = new URL(
      "/.well-known/oauth-protected-resource" +
        (resource.pathname === "/" ? "" : resource.pathname),
      resource.origin,
    ).href;
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      config.url,
      { resourceMetadataUrl },
      (input, init) => {
        if (new URL(String(input)).href !== resourceMetadataUrl) throw failed();
        return this.request(state, String(input), init, signal, false);
      },
    );
    if (
      resourceMetadata.resource !== resource.href ||
      !resourceMetadata.authorization_servers?.includes(oauth.issuer)
    )
      throw failed();
    const allowed = new Set(buildDiscoveryUrls(oauth.issuer).map(({ url }) => url.href));
    const metadata = await discoverAuthorizationServerMetadata(oauth.issuer, {
      fetchFn: (input, init) => {
        if (!allowed.has(new URL(String(input)).href)) throw failed();
        return this.request(state, String(input), init, signal, true);
      },
    });
    if (
      !metadata ||
      metadata.issuer !== oauth.issuer ||
      !metadata.code_challenge_methods_supported?.includes("S256")
    )
      throw failed();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
      if (!endpoint) throw failed();
      this.endpoint(state, endpoint, true);
    }
    state.metadata = metadata;
    return metadata;
  }
  private endpoint(state: State, value: string, as: boolean): string {
    const url = new URL(value);
    const origin = new URL(as ? state.entry.config.oauth!.issuer : state.entry.config.url).origin;
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[\s\\]/u.test(value)
    )
      throw failed();
    return url.href;
  }
  private async request(
    state: State,
    url: string,
    init: RequestInit | undefined,
    signal: AbortSignal,
    as: boolean,
  ): Promise<Response> {
    const fixed = this.endpoint(state, url, as);
    this.environment ??= createPlatformExecutionEnvironment({ workspaceRoot: process.cwd() });
    const owner = createMcpHttpFetch({
      url: fixed,
      headers: {},
      allowedAddresses: as
        ? state.entry.config.oauth!.allowedAddresses
        : state.entry.config.allowedAddresses,
      runEnvironment: this.environment.hostNetwork ?? this.environment,
      signal,
    });
    this.owners.add(owner);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_MS);
    try {
      const response = await owner.fetch(fixed, {
        ...init,
        ...(init?.body !== undefined ? { body: String(init.body) } : {}),
        signal: AbortSignal.any([signal, deadline.signal]),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader)
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > MAX_JSON) {
            await reader.cancel();
            throw failed();
          }
          chunks.push(result.value);
        }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
      await owner.close();
      this.owners.delete(owner);
    }
  }

  private async callback(state: State, metadata: AuthorizationServerMetadata, signal: AbortSignal) {
    const expectedState = randomBytes(32).toString("base64url");
    const callbackPath = `/callback/${randomUUID()}`;
    const sockets = new Set<Socket>();
    let callbackUrl = "";
    let consumed = false;
    let accept!: (value: { code: string; issuer?: string }) => void;
    let reject!: (error: Error) => void;
    const code = new Promise<{ code: string; issuer?: string }>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    void code.catch(() => {});
    const listener = createServer(
      { maxHeaderSize: 8 * 1024, requestTimeout: REQUEST_MS },
      (request, response) => {
        try {
          const target = new URL(request.url ?? "", callbackUrl);
          const params = target.searchParams;
          const seen = new Set<string>();
          if (
            consumed ||
            signal.aborted ||
            request.method !== "GET" ||
            request.headers.host !== new URL(callbackUrl).host ||
            target.origin !== new URL(callbackUrl).origin ||
            target.pathname !== callbackPath ||
            (request.url?.length ?? 0) > 8192
          )
            throw failed();
          for (const key of params.keys()) {
            if (seen.has(key)) throw failed();
            seen.add(key);
          }
          const actual = Buffer.from(params.get("state") ?? "", "utf8");
          const expected = Buffer.from(expectedState, "utf8");
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw failed();
          const issuer = params.get("iss");
          if (
            (issuer !== null && issuer !== state.entry.config.oauth!.issuer) ||
            (metadata.authorization_response_iss_parameter_supported === true && issuer === null)
          )
            throw failed();
          if (params.has("error") || !params.get("code")) throw failed();
          consumed = true;
          response
            .writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            })
            .end("授权已接收，可以关闭此页面。");
          accept({ code: params.get("code")!, ...(issuer !== null ? { issuer } : {}) });
        } catch {
          consumed = true;
          response.writeHead(400).end("授权响应无效");
          reject(failed());
        }
      },
    );
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, fail) => {
      listener.once("error", fail);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw failed();
    callbackUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
    let closing: Promise<void> | undefined;
    const cancel = () => reject(safeError(undefined, signal));
    signal.addEventListener("abort", cancel, { once: true });
    const close = () => {
      if (closing) return closing;
      signal.removeEventListener("abort", cancel);
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>((resolve, fail) =>
        listener.close((error) => (error ? fail(failed()) : resolve())),
      );
      this.callbacks.delete(close);
      return closing;
    };
    this.callbacks.add(close);
    if (signal.aborted) {
      await close();
      throw aborted();
    }
    return { url: callbackUrl, state: expectedState, code, close };
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
}
function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MCP_AUTH_MAX_SECRET_LENGTH &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 拒绝控制字符与空白，防止 Token 注入 Header。
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}
function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(safeError(undefined, signal));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(safeError(undefined, signal));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
function safeError(cause: unknown, signal?: AbortSignal): McpStdioError {
  const knownCause =
    cause instanceof McpStdioError &&
    [
      "mcp_auth_required",
      "mcp_auth_failed",
      "mcp_auth_store_failed",
      "aborted",
      "run_timeout",
    ].includes(cause.code);
  const source = knownCause ? cause : signal?.aborted ? signal.reason : undefined;
  if (source instanceof McpStdioError) {
    switch (source.code) {
      case "mcp_auth_required":
        return required();
      case "mcp_auth_failed":
        return failed();
      case "mcp_auth_store_failed":
        return storeFailed();
      case "aborted":
        return aborted();
      case "run_timeout":
        return new McpStdioError("run_timeout", "MCP 授权事务超时");
    }
  }
  return signal?.aborted ? aborted() : failed();
}
function required() {
  return new McpStdioError("mcp_auth_required", "需要显式 MCP 授权或重新登录");
}
function failed() {
  return new McpStdioError("mcp_auth_failed", "MCP 认证失败，未自动重试或更换身份");
}
function storeFailed() {
  return new McpStdioError("mcp_auth_store_failed", "MCP 安全存储或认证关闭未完成");
}
function aborted() {
  return new McpStdioError("aborted", "MCP 授权或等待已取消");
}
