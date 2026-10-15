import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    include: ["packages/coremind-runtime/src/mcp-runtime.acceptance.test.ts"],
    setupFiles: [path.resolve(process.cwd(), "test/probes/mcp-startup-timing-setup.mjs")],
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
