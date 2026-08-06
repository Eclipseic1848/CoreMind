import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/** 配置解析错误（文件读取失败或 YAML/JSON 语法错误） */
export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/** 从 YAML/JSON 文本解析配置（YAML 是 JSON 超集，同一解析路径） */
export function parseConfigText(text: string, sourceName = "配置"): unknown {
  try {
    return parseYaml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigParseError(`${sourceName} 语法解析失败：${detail}`);
  }
}

/** 读取并解析配置文件（.yaml/.yml/.json 均支持） */
export async function loadConfigFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new ConfigParseError(
      `无法读取配置文件 ${filePath}：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseConfigText(text, filePath);
}
