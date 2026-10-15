import { describe, expect, it } from "vitest";
import { stripPrivateSkillPayload } from "./skill-privacy.js";

describe("技能私有 payload", () => {
  it("剥离发现目录、代数和搜索私有旁挂，同时保留安全摘要与普通嵌套字段", () => {
    const event = {
      type: "context_prefix",
      toolDiscovery: { version: 1, generation: 0 },
      toolDiscoveryCatalog: "普通用户嵌套内容",
    };
    const payload = Object.freeze({
      event,
      toolDiscoveryCatalog: "私有目录",
      toolDiscoverySelection: "私有选择",
      toolDiscoverySearch: "私有搜索",
    });
    expect(stripPrivateSkillPayload("event", payload)).toEqual({ event });
    expect(payload.toolDiscoveryCatalog).toBe("私有目录");
  });
  it("只移除当前 Fact 的顶层私有字段，保留原对象和普通嵌套数据", () => {
    const nested = Object.freeze({ skillSnapshot: "普通嵌套数据", skillLoad: "普通嵌套数据" });
    const start = Object.freeze({ skillSnapshot: { body: "未加载正文" }, nested });
    const event = Object.freeze({ skillLoad: { id: "private-skill" }, event: nested });

    expect(stripPrivateSkillPayload("start", start)).toEqual({ nested });
    expect(stripPrivateSkillPayload("event", event)).toEqual({ event: nested });
    expect(start.skillSnapshot.body).toBe("未加载正文");
    expect(event.skillLoad.id).toBe("private-skill");
    expect(stripPrivateSkillPayload("event", start)).toBe(start);
    expect(stripPrivateSkillPayload("start", event)).toBe(event);
    expect(stripPrivateSkillPayload("finish", start)).toBe(start);
    for (const value of [undefined, null, 1, "正文", [nested], { nested }]) {
      expect(stripPrivateSkillPayload("start", value)).toBe(value);
    }
  });
});
