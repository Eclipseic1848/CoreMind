// 先 npm run build，再 node --expose-gc scripts/benchmark-protocol-events.mjs。
// 固定事实集测试真实文件读取与分页；堆增量是采样值，不是峰值或生产吞吐承诺。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ProtocolHost } from "../packages/coremind-worker/dist/index.js";

assert.equal(typeof global.gc, "function", "请使用 --expose-gc");
const directory = await mkdtemp(path.join(tmpdir(), "coremind-events-benchmark-"));
const runId = "benchmark-events";
const timestamp = "2026-09-23T00:00:00.000Z";
const iterations = 25;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const runs = path.join(directory, ".coremind", "runs");
  await mkdir(runs, { recursive: true });
  // 仅查询固定本地事实，不发起模型请求。
  process.env.DEEPSEEK_API_KEY = "benchmark-unused";
  const host = new ProtocolHost({ send: () => {} });
  const initialized = await host.handle({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
      config: { schemaVersion: 2, name: "benchmark", agents: { main: {} } },
      configDir: directory,
    },
  });
  assert.ok(!initialized.error, JSON.stringify(initialized));
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0].model,
      iterations,
    }),
  );
  for (const count of [1000, 10000]) {
    const records = Array.from({ length: count + 1 }, (_, index) => ({
      version: 1,
      runId,
      sequence: index + 1,
      timestamp,
      kind: index === 0 ? "start" : "event",
      payload:
        index === 0
          ? { configName: "benchmark" }
          : {
              eventId: `event-${index}`,
              runId,
              sequence: index,
              timestamp,
              event: { type: "text_delta", agent: "main", delta: "固定分页负载。".repeat(32) },
            },
    }));
    const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(path.join(runs, `${runId}.jsonl`), text, "utf8");
    const request = {
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "page",
      method: "events",
      params: { runId, afterSequence: Math.floor(count / 2), limit: 100 },
    };
    for (let warmup = 0; warmup < 5; warmup++) await host.handle(request);
    const elapsed = [],
      cpu = [],
      heap = [];
    let responseHash;
    for (let iteration = 0; iteration < iterations; iteration++) {
      global.gc();
      const beforeHeap = process.memoryUsage().heapUsed;
      const beforeCpu = process.cpuUsage();
      const beforeTime = performance.now();
      const response = await host.handle(request);
      elapsed.push(performance.now() - beforeTime);
      const usage = process.cpuUsage(beforeCpu);
      cpu.push((usage.user + usage.system) / 1000);
      heap.push((process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024);
      assert.ok(!response.error, JSON.stringify(response));
      assert.equal(response.result.events.length, 100);
      const hash = createHash("sha256").update(JSON.stringify(response)).digest("hex");
      responseHash ??= hash;
      assert.equal(hash, responseHash);
    }
    console.log(
      JSON.stringify({
        records: records.length,
        fixtureSha256: createHash("sha256").update(text).digest("hex"),
        responseHash,
        medianWallMs: median(elapsed),
        medianCpuMs: median(cpu),
        medianHeapDeltaMiB: median(heap),
      }),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
