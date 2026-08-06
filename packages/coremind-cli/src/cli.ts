#!/usr/bin/env node
// CoreMind CLI 入口（bin: coremind）
import { main } from "./index.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
