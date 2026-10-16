import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CustomProviderConfig, validateConfig } from "coremind-config";
import { describe, expect, it, type TestContext } from "vitest";
import type { SecretResolver } from "./provider.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

const KEY = "sk-fixture-private-key-285";
const HEADER = "Bearer fixture-private-header-285";
const X_KEY = "fixture-private-x-key-285";
const secrets = [KEY, HEADER, HEADER.slice("Bearer ".length), X_KEY];
type AuthorizationState = "absent" | "key" | "header" | "unexpected";
interface Observation {
  routeCorrect: boolean;
  modelCorrect: boolean;
  messagesSafe: boolean;
  authorization: AuthorizationState;
  authorizationCount: number;
  xKey: "absent" | "expected" | "unexpected";
  tenantCorrect: boolean;
}
interface Input {
  provider?: Partial<CustomProviderConfig>;
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
}
interface AuthProbe {
  directory: string;
  observations: Observation[];
  create(input: Input): Promise<CoreMindRuntime>;
}
interface SuccessCase extends Input {
  name: string;
  authorization: AuthorizationState;
  xKey?: "expected";
  tenant?: boolean;
}
const successCases: SuccessCase[] = [
  { name: "免密钥端点不发送任何 Authorization", env: {}, authorization: "absent" },
  {
    name: "仅环境 Header 认证不要求额外 key",
    provider: { headers: { Authorization: { env: "HEADER_AUTH" } } },
    env: { HEADER_AUTH: HEADER },
    authorization: "header",
  },
  {
    name: "仅 SecretRef Header 认证保留小写 Header",
    provider: { headers: { authorization: { secretRef: "opaque/header" } } },
    resolver: { resolve: async (ref) => (ref === "opaque/header" ? HEADER : undefined) },
    authorization: "header",
  },
  {
    name: "仅 X-API-Key 认证不增加默认 Bearer",
    provider: { headers: { "X-API-Key": { env: "HEADER_KEY" } } },
    env: { HEADER_KEY: X_KEY },
    authorization: "absent",
    xKey: "expected",
  },
  {
    name: "显式 API key 保持真实 Bearer",
    provider: { apiKeyEnv: "EXPLICIT_KEY" },
    env: { EXPLICIT_KEY: KEY },
    authorization: "key",
  },
  {
    name: "原推断环境变量仍可提供 API key",
    env: { AUTH_MATRIX_API_KEY: KEY },
    authorization: "key",
  },
  {
    name: "显式 Authorization 覆盖 key 且普通 Header 真实送达",
    provider: {
      apiKeyEnv: "EXPLICIT_KEY",
      headers: {
        aUtHoRiZaTiOn: { env: "HEADER_AUTH" },
        "X-Tenant": "fixture-tenant",
      },
    },
    env: { EXPLICIT_KEY: KEY, HEADER_AUTH: HEADER },
    authorization: "header",
    tenant: true,
  },
];

describe("自定义兼容端点的实际认证请求", () => {
  it.for(successCases)("$name", async (item, context) => {
    await withEndpoint(context, 200, async (probe) => {
      const runtime = await probe.create(item);
      const result = await runtime.run();
      expect(await runtime.waitForQuiescence()).toBe(true);
      expect(result.outcome.status).toBe("succeeded");
      expect(probe.observations).toEqual([
        {
          routeCorrect: true,
          modelCorrect: true,
          messagesSafe: true,
          authorization: item.authorization,
          authorizationCount: item.authorization === "absent" ? 0 : 1,
          xKey: item.xKey ?? "absent",
          tenantCorrect: item.tenant ?? false,
        },
      ]);
      expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
      assertNoSecrets(result);
      assertNoSecrets(
        await new FileRunStore(path.join(probe.directory, "runs")).read(result.runId),
      );
    });
  });

  it("401 不降级匿名或再次请求，错误与事实不泄露解析后的 Header", async (context) => {
    await withEndpoint(context, 401, async (probe) => {
      const runtime = await probe.create({
        provider: { headers: { Authorization: { secretRef: "opaque/header" } } },
        resolver: { resolve: async () => HEADER },
      });
      const result = await runtime.run();
      expect(await runtime.waitForQuiescence()).toBe(true);
      expect(result.outcome.status).not.toBe("succeeded");
      expect(probe.observations).toHaveLength(1);
      expect(probe.observations[0]).toMatchObject({
        authorization: "header",
        authorizationCount: 1,
      });
      expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
      assertNoSecrets(result);
      assertNoSecrets(
        await new FileRunStore(path.join(probe.directory, "runs")).read(result.runId),
      );
    });
  });
});

interface RejectionCase extends Input {
  name: string;
  code: string;
}
const rejections: RejectionCase[] = [
  {
    name: "显式 key 变量缺失不能回退有效 Header 或推断 key",
    provider: { apiKeyEnv: "REQUIRED_KEY", headers: { Authorization: { env: "HEADER_AUTH" } } },
    env: { HEADER_AUTH: HEADER, AUTH_MATRIX_API_KEY: KEY },
    code: "secret_reference_unresolved",
  },
  {
    name: "key SecretRef 无 resolver 不能回退推断 key",
    provider: { apiKeySecretRef: { secretRef: "opaque/missing-key" } },
    env: { AUTH_MATRIX_API_KEY: KEY },
    code: "secret_reference_unresolved",
  },
  {
    name: "key SecretRef 空白不能降级匿名",
    provider: { apiKeySecretRef: { secretRef: "opaque/blank-key" } },
    resolver: { resolve: async () => " " },
    code: "secret_reference_unresolved",
  },
  {
    name: "key SecretRef 解析异常不能泄露原异常或降级匿名",
    provider: { apiKeySecretRef: { secretRef: "opaque/throw-key" } },
    resolver: {
      resolve: async () => {
        throw new Error(`resolver-private ${KEY}`);
      },
    },
    code: "secret_reference_unresolved",
  },
  {
    name: "缺失 Header 环境引用不能当作匿名",
    provider: { headers: { Authorization: { env: "MISSING_HEADER" } } },
    code: "secret_reference_unresolved",
  },
  {
    name: "空白 Header 引用不能忽略后使用推断 key",
    provider: { headers: { "X-API-Key": { env: "BLANK_HEADER" } } },
    env: { BLANK_HEADER: " ", AUTH_MATRIX_API_KEY: KEY },
    code: "secret_reference_unresolved",
  },
  {
    name: "Header SecretRef 无 resolver 不能当作匿名",
    provider: { headers: { Authorization: { secretRef: "opaque/missing-header" } } },
    code: "secret_reference_unresolved",
  },
  {
    name: "明文 key 在 full 模式仍被安全门拒绝",
    provider: { apiKey: KEY },
    code: "execution_security_violation",
  },
  {
    name: "明文 Authorization 在 full 模式仍被拒绝",
    provider: { headers: { Authorization: HEADER } },
    code: "execution_security_violation",
  },
  {
    name: "明文 X-API-Key 在 full 模式仍被拒绝",
    provider: { headers: { "X-API-Key": X_KEY } },
    code: "execution_security_violation",
  },
];
describe("自定义兼容认证的失败关闭", () => {
  it.for(rejections)("$name", async (item, context) => {
    await withEndpoint(context, 200, async (probe) => {
      const error = await probe.create(item).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: item.code });
      expect(probe.observations).toHaveLength(0);
      assertNoSecrets(String(error));
      expect(String(error)).not.toContain("opaque/");
      expect(String(error)).not.toContain("resolver-private");
    });
  });
});

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("coremind-keyless");
}

async function withEndpoint(
  context: TestContext,
  status: 200 | 401,
  check: (probe: AuthProbe) => Promise<void>,
): Promise<void> {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, "coremind-provider-auth-"));
  const observations: Observation[] = [];
  const runtimes: CoreMindRuntime[] = [];
  const controller = new AbortController();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const authorization = request.headers.authorization;
      let modelCorrect = false;
      try {
        modelCorrect = JSON.parse(body).model === "auth-probe-model";
      } catch {
        /* 只记录安全布尔值。 */
      }
      observations.push({
        routeCorrect: request.method === "POST" && request.url === "/v1/chat/completions",
        modelCorrect,
        messagesSafe: !secrets.some((secret) => body.includes(secret)),
        authorization:
          authorization === undefined
            ? "absent"
            : authorization === `Bearer ${KEY}`
              ? "key"
              : authorization === HEADER
                ? "header"
                : "unexpected",
        authorizationCount: request.rawHeaders.filter(
          (name, index) => index % 2 === 0 && name.toLowerCase() === "authorization",
        ).length,
        xKey:
          request.headers["x-api-key"] === undefined
            ? "absent"
            : request.headers["x-api-key"] === X_KEY
              ? "expected"
              : "unexpected",
        tenantCorrect: request.headers["x-tenant"] === "fixture-tenant",
      });
      if (status === 401 || observations.length > 1) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: `Unauthorized Authorization: ${HEADER}\nX-API-Key: ${X_KEY}` },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "auth", choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "auth", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  let body: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const cancel = () => {
    controller.abort();
    server.closeAllConnections();
  };
  const close = () =>
    (closing ??= (async () => {
      cancel();
      await body?.catch(() => undefined);
      let quiescent = false;
      try {
        let allIdle = true;
        for (const runtime of runtimes) if (!(await runtime.waitForQuiescence())) allIdle = false;
        quiescent = allIdle;
        expect(quiescent).toBe(true);
      } finally {
        try {
          if (server.listening)
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
        } finally {
          context.signal.removeEventListener("abort", cancel);
          if (quiescent) {
            expect(path.dirname(path.resolve(directory))).toBe(parent);
            expect(path.basename(directory).startsWith("coremind-provider-auth-")).toBe(true);
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    })());
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(close);
  if (context.signal.aborted) cancel();
  body = (async () => {
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    controller.signal.throwIfAborted();
    await check({
      directory,
      observations,
      create: async (input) => {
        const runtime = await CoreMindRuntime.create({
          config: validateConfig({
            schemaVersion: 2,
            name: "认证请求回归",
            defaultAgent: "main",
            provider: {
              id: "auth-matrix",
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
              model: "auth-probe-model",
              ...input.provider,
            },
            agents: { main: { systemPrompt: "返回一次完成结果", tools: [] } },
            permissions: { mode: "full", workspaceOnly: true, network: "allow" },
            runtime: { maxTurns: 2, maxRetries: 2, runTimeoutMs: 5_000 },
          }),
          configDir: directory,
          cwd: directory,
          initialPrompt: "执行一次请求",
          env: input.env ?? {},
          secretResolver: input.resolver,
          signal: controller.signal,
          runStore: new FileRunStore(path.join(directory, "runs")),
        });
        runtimes.push(runtime);
        return runtime;
      },
    });
  })();
  try {
    await body;
  } finally {
    await close();
  }
}
