import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

/** 唯一本地 AS 与受保护 MCP；记录不保存令牌、code、verifier 或回调 query。 */
export async function startMcpAuthServer({ mode = "normal", expiresIn = 3600 } = {}) {
  const records = [];
  const sockets = new Set();
  const codes = new Map();
  const refreshTokens = new Set();
  const heldCalls = new Set();
  let currentAccess;
  let firstRefresh;
  let generation = 0;
  let releaseRefresh;
  let refreshGate;
  let origin;
  const scopes = ["mcp:read"];
  const clientId = "coremind-public-test";
  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const target = new URL(request.url, origin);
    records.push({ type: "http", method: request.method, path: target.pathname });
    if (target.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(response, {
        resource: mode === "wrong-resource" ? `${origin}/other` : `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: scopes,
      });
      return;
    }
    if (target.pathname === "/.well-known/oauth-authorization-server") {
      json(response, {
        issuer: mode === "wrong-issuer" ? `${origin}/other` : origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint:
          mode === "cross-token" ? "https://unapproved.invalid/token" : `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: mode === "missing-pkce" ? [] : ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: scopes,
      });
      return;
    }
    if (target.pathname === "/authorize") {
      const params = target.searchParams;
      const valid =
        request.method === "GET" &&
        params.get("client_id") === clientId &&
        params.get("response_type") === "code" &&
        params.get("resource") === `${origin}/mcp` &&
        params.get("code_challenge_method") === "S256" &&
        Boolean(params.get("state")) &&
        /^[A-Za-z0-9_-]{43}$/u.test(params.get("code_challenge") ?? "") &&
        params.get("scope") === scopes.join(" ");
      records.push({ type: "authorization", valid });
      if (!valid) {
        response.writeHead(400).end();
        return;
      }
      const redirect = new URL(params.get("redirect_uri"));
      if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port) {
        response.writeHead(400).end();
        return;
      }
      const code = randomUUID();
      codes.set(code, { challenge: params.get("code_challenge"), redirect: redirect.href });
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", params.get("state"));
      redirect.searchParams.set("iss", origin);
      response.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (target.pathname === "/token") {
      if (mode === "redirect-token") {
        response.writeHead(307, { location: `${origin}/unapproved-token` }).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) request.destroy();
      });
      request.on("end", () => {
        void (async () => {
          const params = new URLSearchParams(body);
          const refreshing = params.get("grant_type") === "refresh_token";
          let valid =
            request.method === "POST" &&
            params.get("client_id") === clientId &&
            params.get("resource") === `${origin}/mcp`;
          if (refreshing) valid &&= refreshTokens.has(params.get("refresh_token"));
          else {
            const code = codes.get(params.get("code"));
            const verifier = params.get("code_verifier") ?? "";
            valid &&=
              params.get("grant_type") === "authorization_code" &&
              Boolean(code) &&
              params.get("redirect_uri") === code?.redirect &&
              createHash("sha256").update(verifier, "ascii").digest("base64url") ===
                code?.challenge;
            codes.delete(params.get("code"));
          }
          records.push({
            type: "token",
            grant: refreshing ? "refresh_token" : "authorization_code",
            valid,
          });
          if (!valid) {
            json(response, { error: "invalid_grant" }, 400);
            return;
          }
          if (refreshing && mode === "reject-refresh") {
            json(response, { error: "invalid_grant" }, 400);
            return;
          }
          if (refreshing && refreshGate) await refreshGate;
          generation++;
          currentAccess = `access-${generation}-${randomUUID()}`;
          firstRefresh ??= `refresh-${randomUUID()}`;
          refreshTokens.add(firstRefresh);
          json(response, {
            access_token: currentAccess,
            refresh_token: firstRefresh,
            token_type: "Bearer",
            expires_in: refreshing ? 3600 : expiresIn,
            scope:
              mode === "extra-scope" ? `${scopes.join(" ")} unexpected:write` : scopes.join(" "),
          });
        })().catch(() => {
          if (!response.destroyed) response.writeHead(500).end();
        });
      });
      return;
    }
    if (target.pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const authorized =
      typeof currentAccess === "string" &&
      request.headers.authorization === `Bearer ${currentAccess}`;
    records.push({ type: "mcp", authorized, method: request.method });
    if (!authorized) {
      response
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        const message = JSON.parse(body);
        records.push({ type: "rpc", method: message.method, authorized: true });
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result;
        if (message.method === "initialize")
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "protected-fixture", version: "1" },
          };
        else if (message.method === "tools/list")
          result = {
            tools: [
              {
                name: "echo",
                description: "认证后回显",
                inputSchema: { type: "object", properties: { value: {} }, required: ["value"] },
              },
            ],
          };
        else if (message.method === "tools/call") {
          if (mode === "reject-call") {
            response.writeHead(401).end();
            return;
          }
          if (mode === "hold-access") {
            const token = currentAccess;
            const release = () =>
              json(response, {
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: token }] },
              });
            heldCalls.add(release);
            response.once("close", () => heldCalls.delete(release));
            return;
          }
          if (mode === "error-access") {
            json(response, { message: currentAccess }, 500);
            return;
          }
          if (mode === "header-access") response.setHeader("x-private", currentAccess);
          result = {
            content: [
              {
                type: "text",
                text:
                  mode === "echo-access" || mode === "split-access"
                    ? currentAccess
                    : mode === "echo-refresh"
                      ? firstRefresh
                      : mode === "large-secret"
                        ? "安全正文".repeat(10000) + currentAccess
                        : mode === "large-safe"
                          ? "安全正文".repeat(10000)
                          : "已授权 false 0 null",
              },
            ],
          };
          if (mode === "split-access") {
            const serialized = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
            const split = serialized.indexOf(currentAccess) + Math.floor(currentAccess.length / 2);
            response.writeHead(200, { "content-type": "application/json" });
            response.write(serialized.slice(0, split));
            setImmediate(() => response.end(serialized.slice(split)));
            return;
          }
        } else if (message.method === "resources/read")
          result = { contents: [{ uri: message.params.uri, text: "已授权资源" }] };
        else result = { resources: [] };
        response.setHeader("mcp-session-id", "authorized-session");
        json(response, { jsonrpc: "2.0", id: message.id, result });
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer: origin,
    url: `${origin}/mcp`,
    clientId,
    scopes,
    records,
    sockets,
    config: {
      transport: "streamable-http",
      url: `${origin}/mcp`,
      allowedAddresses: ["127.0.0.1"],
      oauth: { issuer: origin, clientId, scopes, allowedAddresses: ["127.0.0.1"] },
    },
    holdRefresh() {
      refreshGate = new Promise((resolve) => {
        releaseRefresh = resolve;
      });
    },
    releaseRefresh() {
      releaseRefresh?.();
      refreshGate = undefined;
    },
    setMode(value) {
      mode = value;
    },
    releaseCalls() {
      for (const release of heldCalls) release();
      heldCalls.clear();
    },
    async completeAuthorization(authorizationUrl, changes = {}, callbackOptions = {}) {
      assert.equal(new URL(authorizationUrl).origin, origin);
      const authorization = await fetch(authorizationUrl, {
        redirect: "manual",
        headers: { connection: "close" },
      });
      assert.equal(authorization.status, 302, "真实 AS 必须接受有效 PKCE 授权请求");
      const callback = new URL(authorization.headers.get("location"));
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) callback.searchParams.delete(name);
        else if (Array.isArray(value)) {
          callback.searchParams.delete(name);
          for (const item of value) callback.searchParams.append(name, item);
        } else callback.searchParams.set(name, String(value));
      }
      assert.equal(callback.protocol, "http:");
      assert.equal(callback.hostname, "127.0.0.1");
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: callback.hostname,
            port: callback.port,
            method: callbackOptions.method ?? "GET",
            path: callbackOptions.absoluteOrigin
              ? callbackOptions.absoluteOrigin + callback.pathname + callback.search
              : (callbackOptions.path ?? callback.pathname) + callback.search,
            headers: { host: callbackOptions.host ?? callback.host, connection: "close" },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
        request.end();
      });
    },
    async close() {
      releaseRefresh?.();
      heldCalls.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
