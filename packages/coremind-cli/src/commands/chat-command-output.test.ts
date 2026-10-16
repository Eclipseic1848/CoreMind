import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ChatSession, CoreMindRuntime } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { cmdChat } from "./chat.js";

vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

it.each([false, true])("readline 命令共用提示/正文交付器，输出失败=%s", async (failOutput) => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-chat-output-"));
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("coremind-chat-output-")
  ) {
    throw new Error("拒绝清理无归属的测试目录");
  }
  const file = path.join(directory, "coremind.json");
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 2, name: "output", agents: { main: {} } }),
    "utf8",
  );
  const chunks: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk, encoding, callback) => {
      chunks.push(String(chunk));
      const done = typeof encoding === "function" ? encoding : callback;
      if (done) callbacks.push(done);
      return chunks.length !== 1;
    });
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const readline = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {},
  });
  vi.mocked(createInterface).mockReturnValue(
    readline as unknown as ReturnType<typeof createInterface>,
  );
  const create = vi.spyOn(CoreMindRuntime, "create").mockResolvedValue({
    resumedContextLength: 1,
    hasAgent: () => true,
    initialMessagesFor: () => [],
  } as unknown as CoreMindRuntime);
  const persist = vi.spyOn(ChatSession.prototype, "persist").mockResolvedValue("session.jsonl");
  try {
    let completed = false;
    const running = cmdChat({ flags: new Map([["no-tui", true]]), positionals: [file] }, [file]);
    void running.then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(chunks).toHaveLength(1);
    expect(completed).toBe(false);
    callbacks[0]!(failOutput ? new Error("Bearer private-pipe-error") : undefined);
    if (!failOutput) {
      process.stdout.emit("drain");
      for (let index = 1; index < callbacks.length; index++) callbacks[index]!();
    }
    await expect(running).resolves.toBe(failOutput ? 1 : 0);
    if (failOutput) {
      expect(chunks).toHaveLength(1);
      expect(diagnostic.mock.calls.flat().join(" ")).toContain("output_delivery_failed");
    } else {
      expect(chunks.join("")).toContain("已恢复会话");
      expect(chunks.join("")).toContain("开始对话");
      expect(chunks.at(-1)).toContain("会话已保存");
    }
    expect(readline.close).toHaveBeenCalled();
  } finally {
    persist.mockRestore();
    create.mockRestore();
    stdout.mockRestore();
    diagnostic.mockRestore();
    vi.mocked(createInterface).mockReset();
    await rm(resolved, { recursive: true, force: true });
  }
});
