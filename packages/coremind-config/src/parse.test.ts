import { describe, expect, it } from "vitest";
import { ConfigParseError, parseConfigText } from "./parse.js";
import { validateConfig } from "./validate.js";

describe("parseConfigText", () => {
  it("解析 YAML 配置", () => {
    const data = parseConfigText(`
schemaVersion: 2
name: demo
provider:
  id: deepseek
agents:
  main:
    systemPrompt: 你好
`);
    expect(data).toMatchObject({ name: "demo", provider: { id: "deepseek" } });
  });

  it("解析 JSON 配置（JSON 是 YAML 超集）", () => {
    const data = parseConfigText(
      JSON.stringify({ schemaVersion: 2, name: "json-demo", agents: { main: {} } }),
    );
    expect(data).toMatchObject({ name: "json-demo" });
  });

  it("语法错误抛出 ConfigParseError", () => {
    expect(() => parseConfigText("schemaVersion: [1, 2")).toThrow(ConfigParseError);
  });

  it("YAML 与 JSON 解析后走同一校验路径", () => {
    const yamlData = parseConfigText("schemaVersion: 2\nname: demo\nagents:\n  main: {}\n");
    const jsonData = parseConfigText('{"schemaVersion":2,"name":"demo","agents":{"main":{}}}');
    const fromYaml = validateConfig(yamlData);
    const fromJson = validateConfig(jsonData);
    expect(fromYaml).toEqual(fromJson);
  });
});
