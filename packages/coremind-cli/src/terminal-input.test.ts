import { expect, it } from "vitest";
import {
  reduceTerminalInput,
  type TerminalInputAction,
  type TerminalInputState,
} from "./terminal-input.js";

function key(
  text = "",
  flags: Partial<Extract<TerminalInputAction, { type: "key" }>["key"]> = {},
): TerminalInputAction {
  return {
    type: "key",
    text,
    key: { return: false, escape: false, backspace: false, ctrl: false, ...flags },
  };
}

it.each(["文\r", "文\r\n"])("合并末字和终止符 %j 后一次提交完整新稿，不清掉候选", (text) => {
  const result = reduceTerminalInput({ draft: "前", revision: 4 }, key(text), {});
  expect(result.state).toEqual({ draft: "前文", revision: 5 });
  expect(result.effects).toEqual([{ type: "submit", text: "前文", revision: 5, target: "draft" }]);
});

it("return flag 和同 chunk 终止符共存仍只提交一次", () => {
  const result = reduceTerminalInput(
    { draft: "原", revision: 2 },
    key("尾\r\n", { return: true }),
    {},
  );
  expect(result.state).toEqual({ draft: "原尾", revision: 3 });
  expect(result.effects).toEqual([{ type: "submit", text: "原尾", revision: 3, target: "draft" }]);
});

it("裸 Enter 提交原稿，普通追加先更新 revision，空白稿不发送", () => {
  const initial = { draft: "已有草稿", revision: 3 };
  expect(reduceTerminalInput(initial, key("", { return: true }), {})).toEqual({
    state: initial,
    effects: [{ type: "submit", text: initial.draft, revision: 3, target: "draft" }],
  });
  expect(reduceTerminalInput(initial, key(" 新字"), {})).toEqual({
    state: { draft: "已有草稿 新字", revision: 4 },
    effects: [],
  });
  expect(
    reduceTerminalInput({ draft: " \n ", revision: 3 }, key("", { return: true }), {}).effects,
  ).toEqual([]);
});

it.each(["一\n二\r", "一\r二\r", "一\r\n二\r\n", "一\n\n"])(
  "内嵌多行 %j 整段留稿，不拆成多个提交",
  (text) => {
    expect(
      reduceTerminalInput({ draft: "原", revision: 0 }, key(text, { return: true }), {}),
    ).toEqual({ state: { draft: "原" + text, revision: 1 }, effects: [] });
  },
);

it.each(["中文👩🏽‍💻\r\n第二行\n尾", "y\r", "\r"])(
  "paste %j 只追加，之后独立 Enter 才一次提交完整草稿",
  (text) => {
    const edited = reduceTerminalInput({ draft: "原", revision: 0 }, { type: "paste", text }, {});
    expect(edited).toEqual({ state: { draft: "原" + text, revision: 1 }, effects: [] });
    expect(reduceTerminalInput(edited.state, key("", { return: true }), {}).effects).toEqual([
      { type: "submit", text: "原" + text, revision: 1, target: "draft" },
    ]);
  },
);

it.each(["😀", "e\u0301", "👩🏽‍💻", "🇨🇳"])("退格完整删除字符簇 %j", (suffix) => {
  expect(
    reduceTerminalInput({ draft: "头" + suffix, revision: 6 }, key("", { backspace: true }), {}),
  ).toEqual({ state: { draft: "头", revision: 7 }, effects: [] });
});

it("submitted 只清同 revision 的稿件，异步迟到不能抹掉新输入", () => {
  const original = { draft: "待提交", revision: 7 };
  expect(
    reduceTerminalInput(original, { type: "submitted", revision: 7, target: "draft" }, {}),
  ).toEqual({ state: { draft: "", revision: 8 }, effects: [] });
  const edited = reduceTerminalInput(original, key("新字"), {}).state;
  expect(
    reduceTerminalInput(edited, { type: "submitted", revision: 7, target: "draft" }, {}),
  ).toEqual({ state: edited, effects: [] });
});

it.each(["y", "Y", "n", "N"])("审批只由独立按键 %j 产生绑定原 approvalId 的 effect", (text) => {
  const initial = { draft: "审批前草稿", revision: 4 };
  expect(reduceTerminalInput(initial, key(text), { approvalId: "approval-a" })).toEqual({
    state: initial,
    effects: [
      {
        type: "approval",
        approvalId: "approval-a",
        decision: text.toLowerCase() === "y" ? "allow" : "deny",
      },
    ],
  });
});

it.each([{ return: true }, { escape: true }])("审批面板独立 Enter/Esc %j 可拒绝原审批", (flags) => {
  const state = { draft: "原稿", revision: 0 };
  expect(reduceTerminalInput(state, key("", flags), { approvalId: "approval-a" })).toEqual({
    state,
    effects: [{ type: "approval", approvalId: "approval-a", decision: "deny" }],
  });
});

it.each(["y\r", "y\r\n", "yn", "yes", "中文合并输入"])(
  "审批合并 chunk %j 绝不被拆为允许或另一次提交",
  (text) => {
    const result = reduceTerminalInput({ draft: "保留", revision: 0 }, key(text), {
      approvalId: "approval-a",
    });
    expect(
      result.effects.filter((effect) => effect.type === "approval" || effect.type === "submit"),
    ).toEqual([]);
    expect(result.state.draft).toBe("保留");
  },
);

it.each(["y", "n", "/abort\r"])(
  "审批中 paste %j 绑定命令稿，显式 Enter 也只产生命令候选",
  (text) => {
    const initial = { draft: "审批前草稿", revision: 4 };
    const result = reduceTerminalInput(
      initial,
      { type: "paste", text },
      { approvalId: "approval-a" },
    );
    expect(result).toEqual({
      state: { ...initial, revision: 5, approvalCommand: { approvalId: "approval-a", text } },
      effects: [],
    });
    expect(
      reduceTerminalInput(result.state, key("", { return: true }), { approvalId: "approval-a" })
        .effects,
    ).toEqual([{ type: "submit", text, revision: 5, target: "approval-command" }]);
  },
);

it("审批中完整合并控制命令只提交一次，effect 不变成审批", () => {
  const result = reduceTerminalInput({ draft: "原稿", revision: 1 }, key("/steer 新指令\r"), {
    approvalId: "approval-a",
  });
  expect(result.state).toEqual({
    draft: "原稿",
    revision: 2,
    approvalCommand: { approvalId: "approval-a", text: "/steer 新指令" },
  });
  expect(result.effects).toEqual([
    { type: "submit", text: "/steer 新指令", revision: 2, target: "approval-command" },
  ]);
});

it("审批命令模式中的 y 只编辑，Esc 回原审批且不丢普通 draft", () => {
  const initial = {
    draft: "保留原稿",
    revision: 5,
    approvalCommand: { approvalId: "approval-a", text: "/steer " },
  };
  const edited = reduceTerminalInput(initial, key("y"), { approvalId: "approval-a" });
  expect(edited).toEqual({
    state: {
      ...initial,
      revision: 6,
      approvalCommand: { approvalId: "approval-a", text: "/steer y" },
    },
    effects: [],
  });
  expect(
    reduceTerminalInput(edited.state, key("", { escape: true }), { approvalId: "approval-a" }),
  ).toEqual({ state: { draft: "保留原稿", revision: 7 }, effects: [] });
});

it("命令模式空稿 Enter 不改解为审批，退格与确认只作用命令稿", () => {
  const initial = {
    draft: "原稿",
    revision: 5,
    approvalCommand: { approvalId: "approval-a", text: "👩🏽‍💻" },
  };
  const empty = reduceTerminalInput(initial, key("", { backspace: true }), {
    approvalId: "approval-a",
  });
  expect(empty.state).toEqual({
    ...initial,
    revision: 6,
    approvalCommand: { approvalId: "approval-a", text: "" },
  });
  expect(
    reduceTerminalInput(empty.state, key("", { return: true }), { approvalId: "approval-a" })
      .effects,
  ).toEqual([]);
  expect(
    reduceTerminalInput(
      initial,
      { type: "submitted", target: "approval-command", revision: 5 },
      { approvalId: "approval-a" },
    ),
  ).toEqual({ state: { draft: "原稿", revision: 6 }, effects: [] });
});

it.each([
  key("y"),
  key("", { escape: true }),
  { type: "paste", text: "y" } as const,
  { type: "submitted", target: "approval-command", revision: 7 } as const,
])("审批已切换时消耗本动作 %j，不把旧命令或 y 交给下一项", (action) => {
  const state = {
    draft: "原稿",
    revision: 7,
    approvalCommand: { approvalId: "approval-old", text: "/steer y" },
  };
  for (const context of [{ approvalId: "approval-new" }, {}]) {
    const result = reduceTerminalInput(state, action, context);
    expect(result.state).toEqual({ draft: "原稿", revision: 8 });
    expect(result.effects).toEqual([expect.objectContaining({ type: "notice" })]);
  }
});

it("Ctrl 快捷键留给原 root handler，空稿退格不伪造编辑", () => {
  const state = { draft: "原稿", revision: 4 };
  expect(reduceTerminalInput(state, key("c", { ctrl: true }), {})).toEqual({ state, effects: [] });
  expect(
    reduceTerminalInput(state, key("y", { ctrl: true }), { approvalId: "approval-a" }),
  ).toEqual({ state, effects: [] });
  const empty = { draft: "", revision: 4 };
  expect(reduceTerminalInput(empty, key("", { backspace: true }), {})).toEqual({
    state: empty,
    effects: [],
  });
});

it.each([
  ["字符簇", "中".repeat(16_384)],
  ["UTF-8", "😀".repeat(16_384)],
])("固定 %s 边界内完整保留输入", (_label, text) => {
  const result = reduceTerminalInput({ draft: "", revision: 0 }, { type: "paste", text }, {});
  expect(result.state.draft === text).toBe(true);
  expect(result.state.revision).toBe(1);
  expect(result.effects).toEqual([]);
});

it.each([
  { type: "paste", text: "中".repeat(16_385) } as const,
  { type: "paste", text: "👨‍👩‍👧‍👦".repeat(2622) } as const,
  key("中".repeat(16_385) + "\r"),
])("超任一固定上限整段拒绝，不截断或提交旧稿", (action) => {
  const state = { draft: "保留原稿", revision: 9 };
  const result = reduceTerminalInput(state, action, {});
  expect(result.state).toEqual(state);
  expect(result.effects).toEqual([expect.objectContaining({ type: "notice" })]);
  expect(Buffer.byteLength((result.effects[0] as { text: string }).text, "utf8")).toBeLessThan(256);
});

it("审批命令稿超限也整段拒绝，并保留原绑定、原稿和 revision", () => {
  const state = {
    draft: "普通原稿",
    revision: 9,
    approvalCommand: { approvalId: "approval-a", text: "/steer 原命令" },
  };
  const result = reduceTerminalInput(
    state,
    { type: "paste", text: "😀".repeat(16_384) },
    { approvalId: "approval-a" },
  );
  expect(result.state).toEqual(state);
  expect(result.effects).toEqual([expect.objectContaining({ type: "notice" })]);
});

it("reducer 不改传入状态和嵌套审批命令对象", () => {
  const state: TerminalInputState = Object.freeze({
    draft: "原稿",
    revision: 1,
    approvalCommand: Object.freeze({ approvalId: "approval-a", text: "/steer " }),
  });
  const edited = reduceTerminalInput(state, key("追加"), { approvalId: "approval-a" });
  expect(state.approvalCommand?.text).toBe("/steer ");
  expect(edited.state.approvalCommand?.text).toBe("/steer 追加");
});
