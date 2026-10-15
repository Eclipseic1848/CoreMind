import { describe, expect, it } from "vitest";
import { isSecretKey, redactSensitiveText, redactUrl } from "./redaction.js";
import { redactSensitiveValue } from "./trace.js";

const canary = "terminal-color-canary";
const red = "\x1b[31m";
const reset = "\x1b[0m";

describe("共享脱敏先识别完整控制序列，再识别凭据", () => {
  it("独立 URL 字段按同样规则净化，保留原业务对象", () => {
    const url = `https://example.invalid/?to${red}ken${reset}=${canary}`;
    const args = Object.freeze({ endpoint: url });
    expect(redactUrl(url)).toBe("https://example.invalid/?token=hidden");
    expect(redactSensitiveValue(args, { redactBodies: false })).toEqual({
      endpoint: "https://example.invalid/?token=hidden",
    });
    expect(args.endpoint).toBe(url);
  });
  it.each([
    [`password=${red}${canary}${reset}`, "password=hidden"],
    [`pass${red}word${reset}=${canary}`, "password=hidden"],
    [`{"pass${red}word${reset}":"${canary}"}`, '{"password":hidden}'],
    [`Bearer ${red}${canary}${reset}`, "Bearer hidden"],
    [`Be${red}arer${reset} ${canary}`, "Bearer hidden"],
    [`Author${red}ization${reset}: Bearer ${canary}`, "Authorization: hidden"],
    [
      `https://example.invalid/?to${red}ken${reset}=${canary}`,
      "https://example.invalid/?token=hidden",
    ],
    [
      `https://user:${red}${canary}${reset}@example.invalid/path?token=${canary}`,
      "https://hidden:hidden@example.invalid/path?token=hidden",
    ],
    [`pass\u0001word=${canary}`, "password=hidden"],
  ])("控制码不能隐藏标签或截断待隐藏的值：%j", (value, expected) => {
    const safe = redactSensitiveText(value);
    expect(safe).toBe(expected);
    expect(safe).not.toContain(canary);
    expect(safe).not.toContain("\x1b");
    expect(redactSensitiveText(safe), "重复净化不能留下或重新暴露残破颜色片段").toBe(safe);
  });

  it.each([
    `pass${red}word${reset}`,
    `api${red}_${reset}key`,
    `Author${red}ization${reset}`,
    "pass\u0001word",
    "client\u0080_secret",
  ])("结构化敏感键按同一净化规则识别：%j", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it("保持原正常多行、缩进、CRLF、普通 URL 与正文省略号", () => {
    const plain = "第一行\t保留缩进\r\n第二行…\nhttps://example.invalid/path?mode=public\n";
    expect(redactSensitiveText(plain)).toBe(plain);
    expect(redactSensitiveText(redactSensitiveText(plain))).toBe(plain);
    for (const key of ["path", "enabled", "ordinary_count"]) expect(isSecretKey(key)).toBe(false);
  });

  it("不可打印 C0/C1 先移除，但 tab、CR 与 LF 保持原文分隔", () => {
    const value = "前\u0001\t中\r\n后\u0080\n";
    expect(redactSensitiveText(value)).toBe("前\t中\r\n后\n");
  });

  it("多行 Header 与彩色值完整脱敏后仍幂等", () => {
    const value = `普通开头\nCookie: session=${red}${canary}${reset}\r\npassword=${red}${canary}${reset}\n普通结尾`;
    const safe = redactSensitiveText(value);
    expect(safe).toBe("普通开头\nCookie: hidden\r\npassword=hidden\n普通结尾");
    expect(redactSensitiveText(safe)).toBe(safe);
  });

  it("结构化展示仅净化副本，原业务参数、键名与 false/0/null 保持不变", () => {
    const key = `pass${red}word${reset}`;
    const args = Object.freeze({ [key]: canary, enabled: false, count: 0, nil: null });
    const original = structuredClone(args);
    const displayed = redactSensitiveValue(args, { redactBodies: false });
    expect(displayed).toEqual({ [key]: "<已隐藏>", enabled: false, count: 0, nil: null });
    expect(args).toEqual(original);
    expect(args[key]).toBe(canary);
    expect(Object.keys(args)[0]).toBe(key);
  });
});
