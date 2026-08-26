import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "phase2-baseline",
    include: ["phase2-baseline.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    sequence: { groupOrder: 4 },
  },
});
