import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** 仅用于真实本地传输验收；既可导入，也可由独立 Worker 的宿主启动。 */
export async function startMcpHttpServer({
  mode = "normal",
  secret = "",
  recordPath,
  toolChanges = false,
} = {}) {
  const records = [];
  const sockets = new Set();
  const pending = new Set();
  const notificationStreams = new Set();
  let sequence = 0;
  let modern = false;
  let sessionCreated = false;
  const record = (value) => {
    records.push(value);
    if (recordPath) appendFileSync(recordPath, `${JSON.stringify(value)}\n`, "utf8");
  };
  let schema = {
    type: "object",
    $defs: { value: {} },
    properties: { value: { $ref: "#/$defs/value" } },
    required: ["value"],
    additionalProperties: false,
  };
  const reply = (response, id, result) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "fixture-session",
    });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: modern ? { resultType: "complete", ...result } : result,
      }),
    );
  };
  const server = createServer((request, response) => {
    const id = ++sequence;
    const current = request.url === "/mcp" ? mode : request.url.slice(1);
    record({
      type: "http",
      id,
      method: request.method,
      path: request.url,
      sessionPresent: request.headers["mcp-session-id"] !== undefined,
      sessionMatched: request.headers["mcp-session-id"] === "fixture-session",
      protocolPresent: request.headers["mcp-protocol-version"] !== undefined,
      resumptionMatched: request.headers["last-event-id"] === "resume-dropped",
      authorizationMatched: secret !== "" && request.headers.authorization === `Bearer ${secret}`,
    });
    response.on("close", () => {
      pending.delete(response);
      notificationStreams.delete(response);
      record({ type: "response-closed", id });
    });
    if (current === "redirect") {
      response.writeHead(307, { location: "/redirect-target" });
      response.end(secret);
      return;
    }
    if (current === "unauthorized" || current === "forbidden" || current === "error-secret") {
      response.writeHead(current === "unauthorized" ? 401 : current === "forbidden" ? 403 : 500, {
        "www-authenticate": `Bearer error="insufficient_scope", error_description="${secret}"`,
      });
      response.end(secret);
      return;
    }
    if (["status-408", "status-421", "status-429", "status-503"].includes(current)) {
      response.writeHead(Number(current.slice(7)), { "retry-after": "0" });
      response.end(secret);
      return;
    }
    if (current === "bad-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{不是合法JSON");
      return;
    }
    if (current === "slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      response.write("开始");
      pending.add(response);
      return;
    }
    if (current === "body-oversize" || current === "gzip-oversize" || current === "body-limit") {
      const bytes = Buffer.from(
        "x".repeat(8 * 1024 * 1024 + (current === "body-limit" ? 0 : 1)),
        "utf8",
      );
      response.writeHead(200, {
        "content-type": "application/json",
        ...(current === "gzip-oversize" ? { "content-encoding": "gzip" } : {}),
      });
      response.end(current === "gzip-oversize" ? gzipSync(bytes) : bytes);
      return;
    }
    if (current === "event-oversize") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${"x".repeat(8 * 1024 * 1024)}\n\n`);
      return;
    }
    if (current === "secret-body") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write(secret.slice(0, 3));
      setImmediate(() => response.end(secret.slice(3)));
      return;
    }
    if (current === "secret-header") {
      response.writeHead(200, { "content-type": "text/plain", "x-private": secret });
      response.end("完成");
      return;
    }
    if (current === "invalid-utf8") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0xff]));
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(202).end();
      return;
    }
    if (request.method === "GET") {
      if (sessionCreated && request.headers["mcp-session-id"] !== "fixture-session") {
        record({
          type: "session-rejected",
          missing: request.headers["mcp-session-id"] === undefined,
        });
        response.writeHead(404).end();
        return;
      }
      if (toolChanges) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": 工具目录通知流\n\n");
        notificationStreams.add(response);
      } else if (current === "short-stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`id: resume-${id}\nretry: 1\n\n`);
      } else if (current === "drop-stream-once" || current === "drop-stream-invalid-utf8") {
        const resumed =
          records.filter((entry) => entry.type === "http" && entry.method === "GET").length > 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `id: resume-dropped\nretry: 1\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: resumed ? "fixture://resumed" : "fixture://before-drop" } })}\n\n`,
        );
        if (current === "drop-stream-invalid-utf8") response.write(Buffer.from([0xe4, 0xb8]));
        pending.add(response);
      } else {
        response.writeHead(405).end();
      }
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      record({ type: "request", method: message.method, params: message.params, id: message.id });
      if (
        sessionCreated &&
        message.method !== "initialize" &&
        request.headers["mcp-session-id"] !== "fixture-session"
      ) {
        record({
          type: "session-rejected",
          missing: request.headers["mcp-session-id"] === undefined,
        });
        response.writeHead(404).end();
        return;
      }
      if (message.id === undefined) {
        if (message.method === "notifications/cancelled" && current.startsWith("cancel-status-")) {
          response.writeHead(Number(current.slice("cancel-status-".length))).end();
          return;
        }
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        sessionCreated = true;
        reply(response, message.id, {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: toolChanges ? { listChanged: true } : {}, resources: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        });
      } else if (message.method === "server/discover") {
        modern = true;
        reply(response, message.id, {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: toolChanges ? { listChanged: true } : {}, resources: {} },
          ttlMs: 0,
          cacheScope: "private",
        });
      } else if (message.method === "tools/list") {
        reply(response, message.id, {
          tools: [{ name: "echo", description: "受控 HTTP 回显", inputSchema: schema }],
          ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
        });
      } else if (message.method === "tools/call") {
        if (current === "sse-hang-call") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": 已进入请求流\n\n");
          pending.add(response);
          return;
        }
        if (current === "write-drop") {
          record({ type: "effect", name: message.params.name });
          response.destroy();
          return;
        }
        if (current === "hang-call" || current.startsWith("cancel-status-")) {
          pending.add(response);
          return;
        }
        const value = message.params.arguments.value;
        reply(response, message.id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: modern ? value : { result: value },
        });
      } else if (message.method === "resources/list") {
        if (current === "slow-resource-list") {
          pending.add(response);
          return;
        }
        const second = message.params?.cursor === "second";
        reply(response, message.id, {
          resources: [
            {
              uri: second ? "fixture://second" : "fixture://first",
              name: second ? "第二资源" : "第一资源",
              mimeType: "text/plain",
            },
          ],
          ...(!second ? { nextCursor: "second" } : {}),
          ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
        });
      } else if (message.method === "resources/templates/list") {
        const second = message.params?.cursor === "second";
        reply(response, message.id, {
          resourceTemplates: [
            {
              uriTemplate: second ? "fixture://second/{id}" : "fixture://first/{id}",
              name: second ? "第二模板" : "第一模板",
            },
          ],
          ...(!second ? { nextCursor: "second" } : {}),
          ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
        });
      } else if (message.method === "resources/read") {
        reply(response, message.id, {
          contents: [
            { uri: message.params.uri, mimeType: "text/plain", text: "资源正文 false 0 null" },
          ],
          ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
        });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "未知夹具方法" },
          }),
        );
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    record({ type: "socket-open" });
    socket.on("close", () => {
      sockets.delete(socket);
      record({ type: "socket-closed" });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  record({ type: "started", pid: process.pid, url });
  return {
    url,
    records,
    sockets,
    setMode: (next) => {
      mode = next;
    },
    notifyToolsChanged: () => {
      if (!toolChanges || notificationStreams.size === 0) throw new Error("工具目录通知流尚未就绪");
      for (const response of notificationStreams) {
        response.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        );
      }
    },
    changeSchema: (next) => {
      schema = structuredClone(next);
    },
    release: () => {
      for (const response of pending) response.end("结束");
    },
    dropStreams: () => {
      for (const response of pending) response.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [recordPath, mode = "normal"] = process.argv.slice(2);
  if (!recordPath) throw new Error("缺少夹具记录路径");
  const service = await startMcpHttpServer({
    recordPath,
    mode,
    secret: process.env.MCP_TEST_SECRET ?? "",
  });
  process.once("SIGTERM", () => {
    void service.close();
  });
  process.once("SIGINT", () => {
    void service.close();
  });
}
