import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupLinuxSandboxCommand,
  initializeLinuxSandboxBackend,
  type LinuxSandboxConfig,
  shutdownLinuxSandboxBackend,
  wrapLinuxSandboxCommand,
} from "./linux-sandbox-backend.js";
import {
  checkLinuxDependencies,
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "./vendor/linux-sandbox/backend.mjs";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  };
});
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});
vi.mock("./vendor/linux-sandbox/backend.mjs", () => ({
  checkLinuxDependencies: vi.fn(() => ({ errors: [], warnings: [] })),
  cleanupBwrapMountPoints: vi.fn(),
  getDefaultWritePaths: vi.fn(() => []),
  hasRipgrepSync: vi.fn(() => true),
  wrapCommandWithSandboxLinux: vi.fn(async () => "wrapped"),
}));

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let temporary: string;
let previousListeners: ReturnType<typeof process.listeners>;

beforeEach(() => {
  vi.mocked(rmSync).mockReset().mockImplementation(actualFs.rmSync);
  vi.mocked(readFile).mockReset().mockImplementation(actualPromises.readFile);
  vi.mocked(writeFile).mockReset().mockImplementation(actualPromises.writeFile);
  vi.mocked(checkLinuxDependencies).mockReset().mockReturnValue({ errors: [], warnings: [] });
  vi.mocked(cleanupBwrapMountPoints).mockClear();
  vi.mocked(wrapCommandWithSandboxLinux).mockClear();
  temporary = mkdtempSync(path.join(actualOs.tmpdir(), "coremind-helper-owner-test-"));
  vi.mocked(tmpdir).mockReturnValue(temporary);
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  previousListeners = process.listeners("exit");
});

afterEach(async () => {
  vi.mocked(rmSync).mockReset().mockImplementation(actualFs.rmSync);
  await shutdownLinuxSandboxBackend();
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  expect(path.dirname(temporary)).toBe(path.resolve(actualOs.tmpdir()));
  expect(path.basename(temporary)).toMatch(/^coremind-helper-owner-test-/);
  actualFs.rmSync(temporary, { recursive: true, force: true });
});

function ownedDirectories(): string[] {
  return readdirSync(temporary).filter((name) => name.startsWith("coremind-seccomp-"));
}

function ownedListeners() {
  return process.listeners("exit").filter((listener) => !previousListeners.includes(listener));
}

function config(): LinuxSandboxConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [temporary], denyWrite: [] },
    credentials: { files: [], envVars: [] },
    enableWeakerNestedSandbox: false,
    git: { safeDirectories: [] },
  };
}

describe("Linux helper 进程所有权", () => {
  it("两个调用方与后续命令复用一个目录和监听，命令清理不释放进程缓存", async () => {
    const signals = [process.listeners("SIGTERM"), process.listeners("SIGINT")];
    const [first, second] = await Promise.all([
      initializeLinuxSandboxBackend(),
      initializeLinuxSandboxBackend(),
    ]);
    expect(second).toBe(first);
    expect(ownedDirectories()).toHaveLength(1);
    expect(ownedListeners()).toHaveLength(1);
    expect([process.listeners("SIGTERM"), process.listeners("SIGINT")]).toEqual(signals);
    const sandboxConfig = config();
    const protectedPath = path.join(temporary, "protected");
    sandboxConfig.filesystem.denyWrite.push(protectedPath);
    await wrapLinuxSandboxCommand("first", sandboxConfig);
    cleanupLinuxSandboxCommand();
    await wrapLinuxSandboxCommand("second", sandboxConfig);
    expect(wrapCommandWithSandboxLinux).toHaveBeenCalledWith(
      expect.objectContaining({
        seccompConfig: { applyPath: first },
        writeConfig: {
          allowOnly: [temporary],
          denyWithinAllow: [protectedPath, path.dirname(first)],
        },
      }),
    );
    expect(checkLinuxDependencies).toHaveBeenCalledTimes(1);
    expect(ownedDirectories()).toHaveLength(1);
    expect(existsSync(first)).toBe(true);
  });

  it("显式关闭和重复关闭解除监听，重新初始化只取得一个新目录", async () => {
    const first = await initializeLinuxSandboxBackend();
    await shutdownLinuxSandboxBackend();
    expect(existsSync(path.dirname(first))).toBe(false);
    expect(ownedListeners()).toEqual([]);
    await shutdownLinuxSandboxBackend();
    const second = await initializeLinuxSandboxBackend();
    expect(second).not.toBe(first);
    expect(ownedDirectories()).toHaveLength(1);
    expect(ownedListeners()).toHaveLength(1);
  });

  it("旧代的排队关闭不得清空中间新建的初始化 owner", async () => {
    for (const defer of [false, true]) {
      const first = await initializeLinuxSandboxBackend();
      const closingA = shutdownLinuxSandboxBackend();
      let resuming: Promise<string> | undefined;
      const resume = () => {
        resuming = initializeLinuxSandboxBackend();
      };
      // catch 的派生 Promise 会多排一轮；双层微任务将新初始化放到两个关闭续体之间。
      queueMicrotask(() => (defer ? queueMicrotask(resume) : resume()));
      const closingB = shutdownLinuxSandboxBackend();
      await Promise.all([closingA, closingB]);
      expect(resuming).toBeDefined();
      const current = await resuming!;
      expect(current === first).toBe(!defer);
      const next = await initializeLinuxSandboxBackend();
      expect(ownedDirectories()).toHaveLength(1);
      expect(ownedListeners()).toHaveLength(1);
      if (defer) expect(next).toBe(current);
      await shutdownLinuxSandboxBackend();
    }
  });

  it.each(["write", "dependency"])(
    "初始化 %s 失败保留原始原因且不遗留目录或监听",
    async (stage) => {
      const failure = new Error("初始化故障");
      if (stage === "write") vi.mocked(writeFile).mockRejectedValueOnce(failure);
      else
        vi.mocked(checkLinuxDependencies).mockImplementationOnce(() => {
          throw failure;
        });
      await expect(initializeLinuxSandboxBackend()).rejects.toMatchObject({ cause: failure });
      expect(ownedDirectories()).toEqual([]);
      expect(ownedListeners()).toEqual([]);
      await initializeLinuxSandboxBackend();
      expect(ownedDirectories()).toHaveLength(1);
      expect(ownedListeners()).toHaveLength(1);
    },
  );

  it("摘要校验失败不会创建目录或注册退出监听", async () => {
    const bytes = Buffer.from("damaged");
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          artifacts: {
            [`bin/${process.arch}/apply-seccomp`]: createHash("sha256")
              .update("original")
              .digest("hex"),
          },
        }),
      )
      .mockResolvedValueOnce(bytes);
    await expect(initializeLinuxSandboxBackend()).rejects.toThrow("资产摘要不匹配");
    expect(ownedDirectories()).toEqual([]);
    expect(ownedListeners()).toEqual([]);
  });

  it("初始化和清理同时失败时保留两项原因，重试初始化不得覆盖未释放 owner", async () => {
    const failure = new Error("初始化故障");
    const cleanupFailure = new Error("目录清理故障");
    vi.mocked(checkLinuxDependencies).mockImplementationOnce(() => {
      throw failure;
    });
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    const rejected = await initializeLinuxSandboxBackend().catch((error) => error);
    expect(rejected.cause).toMatchObject({ cause: failure, errors: [failure, cleanupFailure] });
    const owned = ownedDirectories();
    expect(owned).toHaveLength(1);
    expect(ownedListeners()).toHaveLength(1);
    await expect(initializeLinuxSandboxBackend()).rejects.toBe(rejected);
    expect(checkLinuxDependencies).toHaveBeenCalledTimes(1);
    expect(ownedDirectories()).toEqual(owned);
    await shutdownLinuxSandboxBackend();
    expect(ownedDirectories()).toEqual([]);
    expect(ownedListeners()).toEqual([]);
    await initializeLinuxSandboxBackend();
    expect(ownedDirectories()).toHaveLength(1);
  });

  it("显式删除失败保留目录和监听，后续关闭可重试", async () => {
    const helper = await initializeLinuxSandboxBackend();
    const failure = new Error("目录清理故障");
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(shutdownLinuxSandboxBackend()).rejects.toBe(failure);
    expect(existsSync(helper)).toBe(true);
    expect(ownedListeners()).toHaveLength(1);
    expect(await initializeLinuxSandboxBackend()).toBe(helper);
    await shutdownLinuxSandboxBackend();
    expect(ownedDirectories()).toEqual([]);
    expect(ownedListeners()).toEqual([]);
  });

  it("退出回调同步清理精确 owner，不触及同级其他目录", async () => {
    const other = path.join(temporary, "coremind-seccomp-other-owner");
    mkdirSync(other);
    const helper = await initializeLinuxSandboxBackend();
    const listener = ownedListeners()[0];
    expect(listener).toBeTypeOf("function");
    listener.call(process, 0);
    expect(existsSync(path.dirname(helper))).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(ownedListeners()).toEqual([]);
  });

  it("退出清理失败可观察且不修改业务退出码，显式关闭仍可重试", async () => {
    const helper = await initializeLinuxSandboxBackend();
    const failure = new Error("目录清理故障");
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw failure;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      process.exitCode = 7;
      expect(() => ownedListeners()[0].call(process, 7)).not.toThrow();
      expect(process.exitCode).toBe(7);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      expect(existsSync(helper)).toBe(true);
      await shutdownLinuxSandboxBackend();
      expect(existsSync(path.dirname(helper))).toBe(false);
    } finally {
      process.exitCode = exitCode;
    }
  });

  it.skipIf(platform.value !== "linux")(
    "真实子进程保护工作区内 helper 并在关闭或退出时清理",
    () => {
      const workspace = path.join(temporary, "workspace");
      const hostTemporary = path.join(workspace, ".tmp");
      mkdirSync(hostTemporary, { recursive: true });
      const source = String.raw`
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { createHash } from "node:crypto";
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      const [entry, workspace] = process.argv.slice(1);
      const backend = await import(entry);
      const { buildLinuxSandboxConfig } = await import(new URL("./linux-sandbox.js", entry));
      const helper = await backend.initializeLinuxSandboxBackend();
      const directory = path.dirname(helper);
      assert.equal(path.dirname(directory), path.join(workspace, ".tmp"));
      const other = path.join(workspace, ".tmp", "other-owner");
      mkdirSync(other);
      const hash = () => createHash("sha256").update(readFileSync(helper)).digest("hex");
      const before = hash();
      // 执行中的 ELF 可能先报 ETXTBSY；未执行的同目录文件单独证明只读保护。
      const canary = path.join(directory, "permission-canary");
      writeFileSync(canary, "unchanged", "utf8");
      const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      async function execute(command) {
        const wrapped = await backend.wrapLinuxSandboxCommand(command, buildLinuxSandboxConfig(workspace, process.env));
        try {
          return execFileSync(wrapped.argv[0], wrapped.argv.slice(1), { cwd: workspace, encoding: "utf8", timeout: 5000 });
        } finally {
          backend.cleanupLinuxSandboxCommand();
        }
      }
      await execute("printf allowed > result.txt");
      assert.equal(readFileSync(path.join(workspace, "result.txt"), "utf8"), "allowed");
      function probe() {
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const path = require("node:path");
        const helper = process.argv[1];
        assert.equal(fs.statSync(helper).isFile(), true);
        function denied(operation, codes = ["EROFS", "EACCES", "EPERM"]) {
          try { operation(); }
          catch (error) {
            assert.ok(codes.includes(error.code), String(error));
            return error.code;
          }
          throw new Error("自有执行资产仍可写入");
        }
        const file = denied(() => { const fd = fs.openSync(path.join(path.dirname(helper), "permission-canary"), "r+"); fs.closeSync(fd); });
        const executable = denied(() => { const fd = fs.openSync(helper, "r+"); fs.closeSync(fd); }, ["EROFS", "EACCES", "EPERM", "ETXTBSY"]);
        const directory = denied(() => fs.mkdirSync(path.join(path.dirname(helper), "forbidden-probe")));
        process.stdout.write(JSON.stringify({ file, directory, executable }));
      }
      const checked = JSON.parse(await execute(quote(process.execPath) + " -e " + quote("(" + probe.toString() + ")()") + " " + quote(helper)));
      assert.equal(hash(), before);
      assert.equal(readFileSync(canary, "utf8"), "unchanged");
      await backend.shutdownLinuxSandboxBackend();
      assert.equal(existsSync(directory), false);
      assert.equal(existsSync(other), true);
      const natural = path.dirname(await backend.initializeLinuxSandboxBackend());
      assert.notEqual(natural, directory);
      process.stdout.write(JSON.stringify({ directory, natural, checked, other }));
    `;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            source,
            new URL("../dist/linux-sandbox-backend.js", import.meta.url).href,
            workspace,
          ],
          { env: { ...process.env, TMPDIR: hostTemporary }, encoding: "utf8", timeout: 12_000 },
        ),
      );
      expect(existsSync(result.directory)).toBe(false);
      expect(existsSync(result.natural)).toBe(false);
      expect(existsSync(result.other)).toBe(true);
      expect(["EROFS", "EACCES", "EPERM"]).toContain(result.checked.file);
      expect(["EROFS", "EACCES", "EPERM"]).toContain(result.checked.directory);
      expect(["EROFS", "EACCES", "EPERM", "ETXTBSY"]).toContain(result.checked.executable);
    },
  );
});
