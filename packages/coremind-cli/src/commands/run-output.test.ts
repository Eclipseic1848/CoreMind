import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoreMindRuntime } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { cmdRun } from "./run.js";

async function withConfig(body: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-output-"));
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("coremind-output-")
  ) {
    throw new Error("拒绝清理无归属的测试目录");
  }
  try {
    const file = path.join(directory, "coremind.json");
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 2, name: "output", agents: { main: {} } }),
      "utf8",
    );
    await body(file);
  } finally {
    await rm(resolved, { recursive: true, force: true });
  }
}

it.each(["print", "json-events"])("%s 等待最后 write callback 和 drain 才返回", async (mode) => {
  await withConfig(async (file) => {
    const chunks: string[] = [];
    const callbacks: Array<() => void> = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk, encoding, callback) => {
        chunks.push(String(chunk));
        const done = typeof encoding === "function" ? encoding : callback;
        if (done) callbacks.push(done);
        return chunks.length !== 1;
      });
    const create = vi.spyOn(CoreMindRuntime, "create").mockImplementation(
      async (options) =>
        ({
          resumedContextLength: 0,
          run: async () => {
            if (mode === "json-events")
              options.events?.({ type: "text_delta", agent: "main", delta: "正文" });
            return { transcript: "正文", outcome: { status: "succeeded" } };
          },
        }) as unknown as CoreMindRuntime,
    );
    try {
      let completed = false;
      const running = cmdRun({ flags: new Map([[mode, true]]), positionals: [file] }, [file]);
      void running.then(() => {
        completed = true;
      });
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks[0]!();
      await Promise.resolve();
      expect(completed).toBe(false);
      process.stdout.emit("drain");
      if (mode === "json-events") {
        expect(callbacks).toHaveLength(2);
        await Promise.resolve();
        expect(completed).toBe(false);
        callbacks[1]!();
      }
      await expect(running).resolves.toBe(0);
      if (mode === "print") expect(chunks).toEqual(["正文\n"]);
      else
        expect(chunks.map((line) => JSON.parse(line).type)).toEqual(["text_delta", "run_result"]);
    } finally {
      create.mockRestore();
      stdout.mockRestore();
    }
  });
});

it("stdout 失败触发取消，但仍等待运行收尾并返回 1", async () => {
  await withConfig(async (file) => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    let finishRun: (() => void) | undefined;
    let aborted = false;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, encoding, callback) => {
        completeWrite = typeof encoding === "function" ? encoding : callback;
        return false;
      });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.spyOn(CoreMindRuntime, "create").mockImplementation(
      async (options) =>
        ({
          resumedContextLength: 0,
          run: () =>
            new Promise((resolve) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
              finishRun = () => resolve({ transcript: "", outcome: { status: "aborted" } });
              options.events?.({ type: "text_delta", agent: "main", delta: "正文" });
            }),
        }) as unknown as CoreMindRuntime,
    );
    try {
      let completed = false;
      const running = cmdRun({ flags: new Map([["json-events", true]]), positionals: [file] }, [
        file,
      ]);
      void running.then(() => {
        completed = true;
      });
      await vi.waitFor(() => expect(completeWrite).toBeDefined());
      completeWrite!(new Error("Bearer private-pipe-error"));
      expect(aborted).toBe(true);
      await Promise.resolve();
      expect(completed).toBe(false);
      finishRun!();
      await expect(running).resolves.toBe(1);
      expect(diagnostic.mock.calls.flat().join(" ")).toContain("output_delivery_failed");
      expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("private-pipe-error");
    } finally {
      create.mockRestore();
      stdout.mockRestore();
      diagnostic.mockRestore();
    }
  });
});
