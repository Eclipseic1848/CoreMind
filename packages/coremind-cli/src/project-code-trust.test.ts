import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { expect, it, vi } from "vitest";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdRun } from "./commands/run.js";
import { createProjectCodeAuthorizer } from "./project-code-trust.js";

vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
const request = {
  projectRoot: "/workspace",
  sources: [{ path: "/workspace/tool.mjs", sha256: "a".repeat(64) }],
  fingerprint: "b".repeat(64),
};

it.each([true, "true", false, "false"])(
  "显式 flag %s 严格映射 boolean，不创建交互输入",
  async (value) => {
    const authorize = createProjectCodeAuthorizer({
      flags: new Map([["trust-project-code", value]]),
      positionals: [],
    });
    expect(await authorize(request)).toBe(value === true || value === "true");
    expect(createInterface).not.toHaveBeenCalled();
  },
);

it.each(["yes", "1", "", "FALSE"])("非法同意值 %s 在 Runtime 初始化前拒绝", (value) => {
  expect(() =>
    createProjectCodeAuthorizer({
      flags: new Map([["trust-project-code", value]]),
      positionals: [],
    }),
  ).toThrow("只能是 true 或 false");
});

for (const answer of ["y", "n", "eof", "cancel"]) {
  it(`TTY 回答 ${answer}：只写 stderr，默认拒绝且完整范围复用`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const reader = Object.assign(new EventEmitter(), {
      question: vi.fn(async (_prompt: string, options: { signal: AbortSignal }) => {
        if (answer === "eof") throw new Error("EOF");
        if (answer === "cancel") {
          reader.emit("SIGINT");
          options.signal.throwIfAborted();
        }
        return answer;
      }),
      close: vi.fn(),
    });
    vi.mocked(createInterface).mockReturnValue(
      reader as unknown as ReturnType<typeof createInterface>,
    );
    const before = process.listeners("SIGINT");
    try {
      const controller = new AbortController();
      const interrupt = vi.fn(() => controller.abort());
      const authorize = createProjectCodeAuthorizer(
        { flags: new Map(), positionals: [] },
        interrupt,
      );
      if (answer === "cancel") {
        await expect(authorize(request, controller.signal)).rejects.toMatchObject({
          code: "aborted",
        });
        expect(interrupt).toHaveBeenCalledOnce();
        expect(controller.signal.aborted).toBe(true);
      } else {
        expect(await authorize(request, controller.signal)).toBe(answer === "y");
        expect(interrupt).not.toHaveBeenCalled();
        expect(controller.signal.aborted).toBe(false);
      }
      if (answer === "y" || answer === "n") {
        expect(await authorize(request)).toBe(answer === "y");
        expect(reader.question).toHaveBeenCalledTimes(1);
        await authorize({ ...request, fingerprint: "c".repeat(64) });
        expect(reader.question).toHaveBeenCalledTimes(2);
      }
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat().join("")).toContain("/workspace/tool.mjs");
      expect(reader.listenerCount("SIGINT")).toBe(0);
      expect(process.listeners("SIGINT")).toEqual(before);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      vi.mocked(createInterface).mockReset();
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
}

for (const trust of [undefined, "false", "invalid", true] as const) {
  it(`非 TTY 的真实 run，trust=${trust}：无明确 true 不 import，full 不替代信任`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-cli-trust-"));
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, encoding, callback) => {
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        return true;
      });
    let calls = 0;
    const server = createServer((incoming, response) => {
      incoming.resume();
      incoming.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish] of [
          [{ role: "assistant", content: "完成" }, null],
          [{}, "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "cli-trust", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const file = path.join(directory, "coremind.json");
      await writeFile(
        path.join(directory, "probe.mjs"),
        `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported",import.meta.url),"imported","utf8");
export default {name:"project_probe",description:"canary",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"ok"}],details:{}})};`,
        "utf8",
      );
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 2,
          name: "cli-trust",
          provider: {
            id: "cli-trust",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            model: "probe",
            apiKeyEnv: "COREMIND_CLI_TRUST_TEST_KEY",
          },
          tools: [{ path: "probe.mjs", effect: { operations: ["read"], reversible: true } }],
          agents: { main: {} },
          runtime: { maxRetries: 0, runTimeoutMs: 5000 },
        }),
        "utf8",
      );
      vi.stubEnv("COREMIND_CLI_TRUST_TEST_KEY", "test-only-key");
      const flags = new Map<string, string | boolean>([
        ["print", true],
        ["permission", "full"],
        ["prompt", "执行"],
      ]);
      if (trust !== undefined) flags.set("trust-project-code", trust);
      expect(
        await cmdRun({ flags, positionals: [file] }, [file]),
        diagnostics.mock.calls.flat().join("\n"),
      ).toBe(trust === true ? 0 : 1);
      expect(existsSync(path.join(directory, "imported"))).toBe(trust === true);
      expect(calls).toBe(trust === true ? 1 : 0);
      expect(createInterface).not.toHaveBeenCalled();
      if (trust === true)
        expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("完成\n");
      // doctor 直接复用同一个真实文件；清掉 canary 后仍不得再次 import。
      await rm(path.join(directory, "imported"), { force: true });
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await cmdDoctor({ flags: new Map(), positionals: [file] }, [file])).toBe(0);
        expect(existsSync(path.join(directory, "imported"))).toBe(false);
        expect(calls).toBe(trust === true ? 1 : 0);
      } finally {
        logs.mockRestore();
      }
    } finally {
      diagnostics.mockRestore();
      stdout.mockRestore();
      vi.unstubAllEnvs();
      vi.mocked(createInterface).mockReset();
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
