import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-tools",
    exclude: [...configDefaults.exclude, "src/host-shell.test.ts"],
    // 宿主 Shell 用例会启动真实子进程；项目级上限需覆盖产品最长 10 秒的受控进程超时。
    testTimeout: 15_000,
  },
});
