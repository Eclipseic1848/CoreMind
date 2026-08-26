import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-cli",
    // 四入口验收会启动 CLI、TUI 与 Python 子进程；避开普通 Runtime 属性测试的资源峰值。
    sequence: { groupOrder: 1 },
    // E2E 用例会启动真实 Node 子进程；并发全量测试下 5 秒不足以区分慢启动与卡死。
    testTimeout: 30_000,
  },
});
