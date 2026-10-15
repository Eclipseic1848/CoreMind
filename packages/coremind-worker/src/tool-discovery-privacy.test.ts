import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunStore, RunStateJournal } from "coremind-ai";
import { expect, it } from "vitest";
import { ProtocolHost } from "./server.js";

process.env.DEEPSEEK_API_KEY = "test-only";

it.each(["v1", "query", "events", "expired"] as const)(
  "%s 出口只剥离工具发现私有旁挂，原始 Store、公开摘要与普通字段不变",
  async (outlet) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-privacy-"));
    const runId = "discovery-privacy";
    const store = new FileRunStore(path.join(directory, ".coremind", "runs"));
    const journal = new RunStateJournal(runId, store);
    const ordinary = {
      toolDiscoveryCatalog: "用户普通嵌套字段",
      toolDiscoveryContinuations: "用户普通嵌套字段",
    };
    const publicPause = { reason: "process_interrupted", note: "保留普通字段" };
    const continuations = {
      version: 1,
      owners: [{ runId, agent: "main", executionId: "private-continuation-canary" }],
    };
    const publicTrace = {
      eventId: "discovery-prefix",
      runId,
      sequence: 2,
      timestamp: "2026-10-14T00:00:00.000Z",
      event: {
        type: "context_prefix" as const,
        agent: "main",
        fingerprint: "prefix-fingerprint",
        toolDiscovery: {
          version: 1 as const,
          catalogFingerprint: "catalog-fingerprint",
          generation: 1,
          selectionFingerprint: "selection-fingerprint",
          toolCount: 1,
        },
      },
    };
    await journal.start({
      configName: "privacy",
      ordinary,
      toolDiscoveryCatalog: { schema: "private-catalog-canary" },
    });
    await journal.appendFact(
      "event",
      {
        ...publicTrace,
        toolDiscoverySelection: { schema: "private-selection-canary" },
        toolDiscoverySearch: { schema: "private-search-canary" },
      },
      { eventId: publicTrace.eventId },
    );
    journal.pause({ ...publicPause, toolDiscoveryContinuations: continuations });
    await journal.flush();
    const original = await store.read(runId);
    const windowedStore = Object.assign(store, {
      readEventWindow: async () => ({
        retainedFromSequence: outlet === "expired" ? 3 : 1,
        latestSequence: 3,
        records: original.filter((record) => outlet !== "expired" || record.sequence === 3),
      }),
    });
    const host = new ProtocolHost({ send: () => {}, runStoreFactory: () => windowedStore });
    try {
      expect(
        await host.handle({
          jsonrpc: "2.0",
          id: "initialize",
          method: "initialize",
          params: {
            ...(outlet === "v1"
              ? { protocolVersion: "1.0" }
              : { protocolRange: { minVersion: "2.0", maxVersion: "2.0" } }),
            config: { schemaVersion: 2, name: "privacy", agents: { main: {} } },
            configDir: directory,
          },
        }),
      ).toHaveProperty("result");
      const response = await host.handle({
        jsonrpc: "2.0",
        ...(outlet === "v1" ? {} : { protocolVersion: "2.0" }),
        id: "inspect",
        method: outlet === "v1" ? "inspect_run" : outlet === "query" ? "query" : "events",
        params: outlet === "v1" || outlet === "query" ? { runId } : { runId, afterSequence: 0 },
      });
      const projection = {
        records: [
          { ...original[0], payload: { configName: "privacy", ordinary } },
          { ...original[1], payload: publicTrace },
          { ...original[2], payload: publicPause },
        ],
        trace: [publicTrace],
      };
      if (outlet === "v1") expect(response).toMatchObject({ result: projection });
      else if (outlet === "query") expect(response).toMatchObject({ result: { projection } });
      else if (outlet === "expired")
        expect(response).toMatchObject({
          error: {
            data: { coremindCode: "cursor_expired", details: { recovery: { projection } } },
          },
        });
      else
        expect(response).toMatchObject({
          result: {
            events: [
              { sequence: 1, payload: { configName: "privacy", ordinary } },
              { sequence: 2, eventId: publicTrace.eventId, payload: publicTrace.event },
              { sequence: 3, payload: publicPause },
            ],
          },
        });
      expect(JSON.stringify(response)).not.toMatch(
        /private-(?:catalog|selection|search|continuation)-canary/,
      );
      expect(await store.read(runId)).toEqual(original);
      expect(JSON.stringify(original)).toContain("private-catalog-canary");
      expect(JSON.stringify(original)).toContain("private-selection-canary");
      expect(JSON.stringify(original)).toContain("private-search-canary");
      expect(original[2]?.payload).toEqual({
        ...publicPause,
        toolDiscoveryContinuations: continuations,
      });
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
