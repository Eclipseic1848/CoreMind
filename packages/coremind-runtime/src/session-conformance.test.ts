import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentMessage,
  buildSessionContext,
  InMemorySessionRepo,
  type Session,
  type SessionContext,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { CoreMindSession } from "./session.js";

interface ContractSession {
  readonly isNew: boolean;
  appendMessages(messages: AgentMessage[]): Promise<void>;
  buildContext(): Promise<SessionContext>;
}

interface SessionBackendHarness {
  open(sessionId: string): Promise<ContractSession>;
}

function message(id: string, text: string): AgentMessage {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function jsonlBackend(): SessionBackendHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-contract-"));
  return {
    open: (sessionId) => CoreMindSession.open({ dir, sessionId, cwd: process.cwd() }),
  };
}

function memoryBackend(): SessionBackendHarness {
  const repository = new InMemorySessionRepo();
  return {
    async open(sessionId) {
      const metadata = (await repository.list()).find((item) => item.id === sessionId);
      const session = metadata
        ? await repository.open(metadata)
        : await repository.create({ id: sessionId });
      return wrapMemorySession(session, metadata === undefined);
    },
  };
}

function wrapMemorySession(session: Session, isNew: boolean): ContractSession {
  return {
    isNew,
    async appendMessages(messages) {
      for (const item of messages) await session.appendMessage(item);
    },
    async buildContext() {
      return buildSessionContext(await session.findEntriesOnBranch({ order: "oldestFirst" }));
    },
  };
}

function sessionBackendConformance(
  label: string,
  createBackend: () => SessionBackendHarness,
): void {
  describe(label, () => {
    it("新建、追加、恢复与继续追加保持一致", async () => {
      const backend = createBackend();
      const created = await backend.open("contract");
      expect(created.isNew).toBe(true);
      await created.appendMessages([message("one", "第一条"), message("two", "第二条")]);

      const resumed = await backend.open("contract");
      expect(resumed.isNew).toBe(false);
      expect((await resumed.buildContext()).messages.map((item) => item.id)).toEqual([
        "one",
        "two",
      ]);

      await resumed.appendMessages([message("three", "第三条")]);
      const reopened = await backend.open("contract");
      expect((await reopened.buildContext()).messages.map((item) => item.id)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    it("空会话恢复不制造消息", async () => {
      const backend = createBackend();
      await backend.open("empty");
      const resumed = await backend.open("empty");
      expect(resumed.isNew).toBe(false);
      expect((await resumed.buildContext()).messages).toEqual([]);
    });
  });
}

describe("Session backend conformance", () => {
  sessionBackendConformance("Memory backend", memoryBackend);
  sessionBackendConformance("JSONL backend", jsonlBackend);
});
