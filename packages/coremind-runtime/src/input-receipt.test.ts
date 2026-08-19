import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import {
  claimInput,
  completeInput,
  createInputReceipt,
  discardInput,
  foldInputReceipts,
  type InputId,
  type InputReceiptStatus,
  inputFingerprint,
  isInputReceiptEvent,
  isValidTransition,
} from "./input-receipt.js";

describe("inputFingerprint", () => {
  it("对同一内容生成稳定指纹，不同内容不同", () => {
    const first = inputFingerprint("你好，世界");
    expect(first).toBe(inputFingerprint("你好，世界"));
    expect(first).not.toBe(inputFingerprint("你好，世界！"));
  });

  it("指纹是十六进制短摘要（不落原文）", () => {
    expect(inputFingerprint("secret content")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("创建函数", () => {
  it("createInputReceipt 生成 pending 收据事件，携带 inputId、指纹与时间戳", () => {
    const event = createInputReceipt({ inputId: "in-1" as InputId, contentFingerprint: "abc" });
    expect(event).toMatchObject({
      type: "input_receipt",
      inputId: "in-1",
      status: "pending",
      contentFingerprint: "abc",
    });
    expect(event.timestamp).toEqual(expect.any(String));
  });

  it("claimInput 生成 claimed 事件并绑定 TurnId", () => {
    const event = claimInput({ inputId: "in-1" as InputId, turnId: "turn-9" });
    expect(event).toMatchObject({
      type: "input_claimed",
      inputId: "in-1",
      status: "claimed",
      turnId: "turn-9",
    });
  });

  it("completeInput 生成 completed 事件", () => {
    const event = completeInput({ inputId: "in-1" as InputId });
    expect(event).toMatchObject({ type: "input_completed", inputId: "in-1", status: "completed" });
  });

  it("discardInput 生成 discarded 事件", () => {
    const event = discardInput({ inputId: "in-1" as InputId });
    expect(event).toMatchObject({ type: "input_discarded", inputId: "in-1", status: "discarded" });
  });
});

describe("isValidTransition（四态机转移表）", () => {
  it("合法转移：pending→claimed、pending→discarded、claimed→completed、claimed→discarded", () => {
    expect(isValidTransition("pending", "claimed")).toBe(true);
    expect(isValidTransition("pending", "discarded")).toBe(true);
    expect(isValidTransition("claimed", "completed")).toBe(true);
    // abort 后已认领但未完成的输入 → discarded（规格 03 §4 验收）
    expect(isValidTransition("claimed", "discarded")).toBe(true);
  });

  it("非法转移：无回退（claimed→pending、completed→任何、discarded→任何）", () => {
    expect(isValidTransition("claimed", "pending")).toBe(false);
    expect(isValidTransition("completed", "claimed")).toBe(false);
    expect(isValidTransition("completed", "discarded")).toBe(false);
    expect(isValidTransition("discarded", "claimed")).toBe(false);
    expect(isValidTransition("discarded", "completed")).toBe(false);
  });
});

describe("foldInputReceipts（事件序列折叠当前状态，不覆盖旧记录）", () => {
  const id = (value: string): InputId => value as InputId;

  it("无收据事件时为空", () => {
    const state = foldInputReceipts([{ type: "agent_start", agent: "a" }]);
    expect(state.size).toBe(0);
  });

  it("pending→claimed→completed 折叠为 completed", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      completeInput({ inputId: id("in-1") }),
    ];
    expect(foldInputReceipts(events).get("in-1")).toBe("completed");
  });

  it("pending→discarded 折叠为 discarded（abort 后未消费）", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      discardInput({ inputId: id("in-1") }),
    ];
    expect(foldInputReceipts(events).get("in-1")).toBe("discarded");
  });

  it("claimed→discarded 折叠为 discarded（已认领但中止的输入）", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      discardInput({ inputId: id("in-1") }),
    ];
    expect(foldInputReceipts(events).get("in-1")).toBe("discarded");
  });

  it("claimed 未终态时保持 claimed（paused 可恢复场景）", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
    ];
    expect(foldInputReceipts(events).get("in-1")).toBe("claimed");
  });

  it("多个输入互不干扰，各自折叠", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "a" }),
      createInputReceipt({ inputId: id("in-2"), contentFingerprint: "b" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      completeInput({ inputId: id("in-1") }),
      discardInput({ inputId: id("in-2") }),
    ];
    const state = foldInputReceipts(events);
    expect(state.get("in-1")).toBe("completed");
    expect(state.get("in-2")).toBe("discarded");
  });

  it("多个输入事件交错（各自内部保序）时独立折叠", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "a" }),
      createInputReceipt({ inputId: id("in-2"), contentFingerprint: "b" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      discardInput({ inputId: id("in-2") }),
      completeInput({ inputId: id("in-1") }),
    ];
    const state = foldInputReceipts(events);
    expect(state.get("in-1")).toBe("completed");
    expect(state.get("in-2")).toBe("discarded");
  });

  it("非法转移（completed 后再次 claimed）抛错——语义损坏 fail closed", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      completeInput({ inputId: id("in-1") }),
      claimInput({ inputId: id("in-1"), turnId: "t2" }),
    ];
    expect(() => foldInputReceipts(events)).toThrow();
  });

  it("未登记就转移（claimed 无 pending 前置）抛错", () => {
    const events: CoreMindEvent[] = [claimInput({ inputId: id("in-1"), turnId: "t1" })];
    expect(() => foldInputReceipts(events)).toThrow();
  });

  it("从事件流中识别收据事件（isInputReceiptEvent 辅助）", () => {
    // 通过折叠行为覆盖：混合无关事件不影响折叠
    const events: CoreMindEvent[] = [
      { type: "agent_start", agent: "a", turnId: "t1" },
      createInputReceipt({ inputId: id("in-1"), contentFingerprint: "fp" }),
      claimInput({ inputId: id("in-1"), turnId: "t1" }),
      { type: "tool_call", agent: "a", tool: "read", args: {} },
      completeInput({ inputId: id("in-1") }),
    ];
    expect(foldInputReceipts(events).get("in-1")).toBe("completed");
  });
});

describe("isInputReceiptEvent", () => {
  it("识别全部收据事件族，非收据事件返回 false", () => {
    const inputId = "in-1" as InputId;
    expect(isInputReceiptEvent(createInputReceipt({ inputId, contentFingerprint: "fp" }))).toBe(
      true,
    );
    expect(isInputReceiptEvent(claimInput({ inputId, turnId: "t1" }))).toBe(true);
    expect(isInputReceiptEvent(completeInput({ inputId }))).toBe(true);
    expect(isInputReceiptEvent(discardInput({ inputId }))).toBe(true);
    expect(isInputReceiptEvent({ type: "agent_start", agent: "a" })).toBe(false);
  });
});

describe("事件序列折叠的状态快照", () => {
  it("导出当前状态汇总（含未完成输入）", () => {
    const events: CoreMindEvent[] = [
      createInputReceipt({ inputId: "in-1" as InputId, contentFingerprint: "a" }),
      claimInput({ inputId: "in-1" as InputId, turnId: "t1" }),
      createInputReceipt({ inputId: "in-2" as InputId, contentFingerprint: "b" }),
    ];
    const state = foldInputReceipts(events);
    const statuses: Record<string, InputReceiptStatus> = Object.fromEntries(state);
    expect(statuses).toEqual({ "in-1": "claimed", "in-2": "pending" });
  });
});
