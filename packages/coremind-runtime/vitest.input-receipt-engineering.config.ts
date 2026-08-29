import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: "coremind-runtime-input-receipt-engineering",
    include: ["src/input-receipt.acceptance.test.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 3 },
    testTimeout: 90_000,
    testNamePattern: /^(?!.*Cancel → Quiescent p95)/u,
  },
});
