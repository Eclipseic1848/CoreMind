#!/usr/bin/env node
// CoreMind CLI 入口（bin: coremind）
import { shutdownPlatformExecutionEnvironment } from "coremind-tools/internal";
import { main } from "./index.js";

async function runCli(): Promise<void> {
  let exitCode = 1;
  try {
    exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  try {
    await shutdownPlatformExecutionEnvironment();
  } catch (error) {
    console.error(`执行环境清理失败：${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

void runCli();
