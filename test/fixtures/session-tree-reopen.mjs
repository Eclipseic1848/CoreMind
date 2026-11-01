import { readFile } from "node:fs/promises";
import { ChatSession, CoreMindRuntime } from "coremind-ai";

// 独立进程只从公共包入口恢复，假 Provider 地址由测试宿主提供。
const { prompt, ...options } = JSON.parse(await readFile(process.argv[2], "utf8"));
const chat = new ChatSession(await CoreMindRuntime.create(options), "main");
const tree = await chat.inspectSessionTree();
const turn = await chat.chat(prompt);
process.stdout.write(JSON.stringify({ tree, status: turn.run.outcome.status }));
