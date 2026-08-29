import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: "coremind-runtime-race-matrix",
    include: ["src/race-matrix.acceptance.test.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 2 },
    testTimeout: 60_000,
  },
});
