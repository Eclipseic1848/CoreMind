import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-tools-host-shell",
    include: ["src/host-shell.test.ts"],
    fileParallelism: false,
    // 等普通并行项目完成后再启动真实宿主 Shell，避免共享 Runner 资源争用。
    sequence: { groupOrder: 1 },
    testTimeout: 15_000,
  },
});
