import { describe, expect, it } from "vitest";
import { environmentCopyCommand } from "./create.js";

describe("create 跨平台引导", () => {
  it("Windows 使用 PowerShell 命令，Linux 使用 POSIX 命令", () => {
    expect(environmentCopyCommand("win32")).toBe("Copy-Item .env.example .env");
    expect(environmentCopyCommand("linux")).toBe("cp .env.example .env");
  });
});
