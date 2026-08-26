import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-tools-host-shell",
    include: ["src/host-shell.test.ts"],
    fileParallelism: false,
    // 等子进程型入口验收完成后再启动真实宿主 Shell；60 秒只覆盖托管 Windows 首次进程启动。
    sequence: { groupOrder: 2 },
    testTimeout: 60_000,
  },
});
