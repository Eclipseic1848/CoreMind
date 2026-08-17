import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { analyzeRunMetrics } from "./result.js";

describe("analyzeRunMetrics", () => {
  it("分别记录输入、输出、真实缓存命中、压缩摘要与 Artifact", () => {
    const events: CoreMindEvent[] = [
      { type: "context_prefix", agent: "main", fingerprint: "prefix-a" },
      {
        type: "turn_end",
        agent: "main",
        tokens: 20,
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        promptCacheStatus: "available",
      },
      {
        type: "context_compacted",
        beforeTokens: 100,
        afterTokens: 40,
        removedMessages: 4,
        strategy: "deterministic-v1",
        reason: "threshold",
        summaryFingerprint: "summary-a",
      },
      {
        type: "artifact_created",
        artifactId: "artifact-a",
        status: "stored",
        sizeBytes: 1024,
        relativePath: ".coremind/artifacts/artifact-a.log",
        sha256: "hash",
        mediaType: "text/plain",
        redaction: "none",
        tool: "bash",
      },
    ];

    const metrics = analyzeRunMetrics(events, [], 10, 0);

    expect(metrics.context).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      promptCacheStatus: "available",
      compactions: 1,
      lastSummaryFingerprint: "summary-a",
      stablePrefixFingerprints: ["prefix-a"],
    });
    expect(metrics.artifacts).toEqual({ stored: 1, blocked: 0, totalBytes: 1024 });
  });

  it("Provider 未声明缓存能力时保持 unavailable 且不伪造命中", () => {
    const metrics = analyzeRunMetrics(
      [
        {
          type: "turn_end",
          agent: "main",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          promptCacheStatus: "unavailable",
        },
      ],
      [],
      10,
      0,
    );

    expect(metrics.context?.promptCacheStatus).toBe("unavailable");
    expect(metrics.context?.cacheReadTokens).toBe(0);
    expect(metrics.context?.cacheWriteTokens).toBe(0);
  });

  it("准入拒绝计数记入 metrics.rejectedAfterAbort；为 0 时不出现", () => {
    const metrics = analyzeRunMetrics([], [], 1, 0, 3);
    const zero = analyzeRunMetrics([], [], 1, 0, 0);

    expect(metrics.rejectedAfterAbort).toBe(3);
    expect(zero.rejectedAfterAbort).toBeUndefined();
  });
});
