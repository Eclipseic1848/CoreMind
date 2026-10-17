import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchWindowsMcpJob } from "./windows-mcp-job.js";

const boundary = vi.hoisted(() => ({ lstat: vi.fn(), execa: vi.fn() }));

// 仅模拟平台和固定旁置路径；资产读取仍真实，禁止启动进程。
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  lstat: boundary.lstat,
}));
vi.mock("execa", () => ({ execa: boundary.execa }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  boundary.lstat.mockReset();
  boundary.execa.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
});

describe("Windows MCP 启动前固定旁置配置检查", () => {
  it.each(["present", "EACCES"] as const)("%s 拒绝且未调用 Execa", async (mode) => {
    if (mode === "present") boundary.lstat.mockResolvedValue({});
    else boundary.lstat.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(
      launchWindowsMcpJob(
        {
          command: process.execPath,
          args: [],
          cwd: process.cwd(),
          env: {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(boundary.lstat).toHaveBeenCalledTimes(1);
    expect(String(boundary.lstat.mock.calls[0]?.[0])).toMatch(/[\\/]host\.exe\.config$/u);
    expect(boundary.execa).not.toHaveBeenCalled();
  });
});
