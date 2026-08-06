import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 会话存储（一期最小实现）：把一轮运行的完整消息落盘为 JSONL。
 * 每行一条 AgentMessage。断点续聊（把消息作为初始 messages 恢复）与
 * 会话树/压缩留待二期接入上游会话存储实现。
 */
export class SessionStore {
  constructor(
    private readonly dir: string,
    private readonly sessionName: string,
  ) {}

  get filePath(): string {
    return path.join(this.dir, `${this.sessionName}.jsonl`);
  }

  /** 落盘全部消息（覆盖写，保持幂等） */
  async save(messages: AgentMessage[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const lines = messages
      .map((m) => {
        try {
          return JSON.stringify(m);
        } catch {
          return null;
        }
      })
      .filter((l): l is string => l !== null);
    await writeFile(this.filePath, lines.join("\n"), "utf8");
  }

  /** 读取历史消息（用于恢复会话） */
  async load(): Promise<AgentMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const messages: AgentMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        messages.push(JSON.parse(line) as AgentMessage);
      } catch {
        // 跳过损坏行
      }
    }
    return messages;
  }
}
