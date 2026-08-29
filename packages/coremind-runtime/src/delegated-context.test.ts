import { describe, expect, it } from "vitest";
import {
  buildDelegatedInitialPrompt,
  resolveDelegatedContextReferences,
} from "./delegated-context.js";

describe("Delegated Context", () => {
  const fact = {
    version: 1 as const,
    runId: "parent-run",
    sequence: 7,
    eventId: "approved:fact",
    timestamp: "2026-08-28T00:00:00.000Z",
    kind: "event" as const,
    payload: { privateBody: "PARENT_PRIVATE_MARKER" },
  };
  const artifact = {
    artifactId: "approved-artifact",
    status: "stored" as const,
    relativePath: ".coremind/artifacts/approved-artifact.log",
    sizeBytes: 12,
    sha256: "abc123",
    mediaType: "text/plain; charset=utf-8",
    createdAt: "2026-08-28T00:00:00.000Z",
    retention: "run" as const,
    redaction: "none" as const,
  };

  it("只解析当前父 Run Fact 与受控 Artifact，并且不复制正文", () => {
    const resolved = resolveDelegatedContextReferences({
      references: ["fact:approved:fact", "artifact:approved-artifact"],
      parentFacts: [fact],
      artifacts: [artifact],
    });
    const prompt = buildDelegatedInitialPrompt("执行子任务", resolved);

    expect(resolved).toEqual([
      expect.objectContaining({
        reference: "fact:approved:fact",
        eventId: "approved:fact",
        factKind: "event",
        payloadFingerprint: expect.stringMatching(/^sha256:/u),
      }),
      expect.objectContaining({
        reference: "artifact:approved-artifact",
        artifactId: "approved-artifact",
        sha256: "abc123",
      }),
    ]);
    expect(prompt).toContain("fact:approved:fact");
    expect(prompt).toContain("artifact:approved-artifact");
    expect(prompt).not.toContain("PARENT_PRIVATE_MARKER");
    expect(prompt).not.toContain(".coremind/artifacts/approved-artifact.log");
  });

  it("拒绝不存在、跨父 Run或被敏感扫描阻断的引用", () => {
    expect(() =>
      resolveDelegatedContextReferences({
        references: ["fact:other-run"],
        parentFacts: [fact],
        artifacts: [artifact],
      }),
    ).toThrowError(expect.objectContaining({ code: "child_run_policy_escalation" }));
    expect(() =>
      resolveDelegatedContextReferences({
        references: ["artifact:approved-artifact"],
        parentFacts: [fact],
        artifacts: [{ ...artifact, status: "blocked", redaction: "blocked-secret" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "child_run_policy_escalation" }));
  });

  it("后代只能原样继承上一层已解析的受保护引用", () => {
    const inherited = resolveDelegatedContextReferences({
      references: ["fact:approved:fact"],
      parentFacts: [fact],
      artifacts: [],
    });
    const resolved = resolveDelegatedContextReferences({
      references: ["fact:approved:fact"],
      parentFacts: [],
      artifacts: [],
      inheritedReferences: inherited,
    });

    expect(resolved).toEqual(inherited);
    expect(resolved).not.toBe(inherited);
  });
});
