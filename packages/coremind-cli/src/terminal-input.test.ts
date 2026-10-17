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

it.each(["👩🏽‍💻", "e\u0301", "🇨🇳", "👨‍👩‍👧‍👦"])("中段左右与退格只操作完整字符簇 %s", (cluster) => {
  const original: TerminalInputState = { draft: `中${cluster}文`, revision: 0 };
  const left = reduceTerminalInput(original, key("", { leftArrow: true }), {}).state;
  expect(left.cursor).toBe(1 + cluster.length);
  const previous = reduceTerminalInput(left, key("", { leftArrow: true }), {}).state;
  expect(previous.cursor).toBe(1);
  const right = reduceTerminalInput(previous, key("", { rightArrow: true }), {}).state;
  expect(right.cursor).toBe(1 + cluster.length);
  const erased = reduceTerminalInput(right, key("", { backspace: true }), {}).state;
  expect(erased).toEqual({ draft: "中文", cursor: 1, revision: 4 });
  const inserted = reduceTerminalInput(erased, key("新"), {}).state;
  expect(inserted).toEqual({ draft: "中新文", cursor: 2, revision: 5 });
});

it("Home/End 是整稿首尾，边界 no-op 不改 revision，换行也是完整导航边界", () => {
  const original: TerminalInputState = { draft: "一\n二", revision: 0 };
  expect(reduceTerminalInput(original, key("", { end: true }), {}).state).toBe(original);
  const start = reduceTerminalInput(original, key("", { home: true }), {}).state;
  expect(start.cursor).toBe(0);
  expect(reduceTerminalInput(start, key("", { leftArrow: true }), {}).state).toBe(start);
  const line = reduceTerminalInput(start, key("", { rightArrow: true }), {}).state;
  expect(line.cursor).toBe(1);
  const second = reduceTerminalInput(line, key("", { rightArrow: true }), {}).state;
  expect(second.cursor).toBe(2);
  const end = reduceTerminalInput(second, key("", { end: true }), {}).state;
  expect(end.cursor).toBeUndefined();
  expect(reduceTerminalInput(end, key("", { rightArrow: true }), {}).state).toBe(end);
});

it("中段插入组合符或 ZWJ 后重新吸附到新字素边界", () => {
  const accent = reduceTerminalInput(
    { draft: "ex", cursor: 1, revision: 0 },
    key("\u0301"),
    {},
  ).state;
  expect(accent).toEqual({ draft: "e\u0301x", cursor: 2, revision: 1 });
  const joined = reduceTerminalInput(
    { draft: "👩💻", cursor: 2, revision: 0 },
    key("\u200d"),
    {},
  ).state;
  expect(joined.draft).toBe("👩‍💻");
  expect(joined.cursor).toBeUndefined();
  expect(reduceTerminalInput(joined, key("", { backspace: true }), {}).state.draft).toBe("");
});

it("中段合并末字 CR 一次提交整稿，多行 paste 只插入且不产生提交", () => {
  const state: TerminalInputState = { draft: "前后", cursor: 1, revision: 5 };
  const result = reduceTerminalInput(state, key("中\r", { return: true }), {});
  expect(result.state).toEqual({ draft: "前中后", cursor: 2, revision: 6 });
  expect(result.effects).toEqual([
    { type: "submit", text: "前中后", target: "draft", revision: 6 },
  ]);
  const pasted = reduceTerminalInput(state, { type: "paste", text: "中\n文\r" }, {});
  expect(pasted.state.draft).toBe("前中\n文\r后");
  expect(pasted.effects).toEqual([]);
  const escapedPaste = reduceTerminalInput(state, { type: "paste", text: "\x1b[Ay\r" }, {});
  expect(escapedPaste.state.draft).toBe("前\x1b[Ay\r后");
  expect(escapedPaste.effects).toEqual([]);
});

function rememberAccepted(state: TerminalInputState, text: string): TerminalInputState {
  const candidate = reduceTerminalInput(state, key(text), {}).state;
  return reduceTerminalInput(
    candidate,
    { type: "submitted", target: "draft", revision: candidate.revision, remember: true },
    {},
  ).state;
}

it("普通已准入历史固定50条、连续重复去重，空白和 slash 即使被误标也不记录", () => {
  let state: TerminalInputState = { draft: "", revision: 0 };
  for (let index = 0; index < 51; index++) state = rememberAccepted(state, `提问-${index}`);
  expect(state.history?.entries).toHaveLength(50);
  expect(state.history?.entries[0]).toBe("提问-1");
  expect(state.history?.entries.at(-1)).toBe("提问-50");
  const entries = state.history?.entries;
  state = rememberAccepted(state, "提问-50");
  expect(state.history?.entries).toBe(entries);
  state = rememberAccepted(state, "  ");
  state = rememberAccepted(state, "/steer 不入历史");
  expect(state.history?.entries).toBe(entries);
  expect(state.history?.index).toBeUndefined();
});

it("历史浏览备份原稿和中段 cursor，编辑回忆稿不改 entries，Down 精确恢复", () => {
  let state: TerminalInputState = { draft: "", revision: 0 };
  state = rememberAccepted(state, "历史一");
  state = rememberAccepted(state, "历史二");
  state = { ...state, draft: "未👩🏽‍💻\n稿", cursor: 1 };
  const entries = state.history!.entries;
  state = reduceTerminalInput(state, key("", { upArrow: true }), {}).state;
  expect(state.draft).toBe("历史二");
  expect(state.history?.draft).toEqual({ text: "未👩🏽‍💻\n稿", cursor: 1 });
  state = reduceTerminalInput(state, key("临时改写"), {}).state;
  expect(state.history?.entries).toBe(entries);
  state = reduceTerminalInput(state, key("", { upArrow: true }), {}).state;
  expect(state.draft).toBe("历史一");
  expect(reduceTerminalInput(state, key("", { upArrow: true }), {}).state).toBe(state);
  state = reduceTerminalInput(state, key("", { downArrow: true }), {}).state;
  expect(state.draft).toBe("历史二");
  state = reduceTerminalInput(state, key("", { downArrow: true }), {}).state;
  expect(state.draft).toBe("未👩🏽‍💻\n稿");
  expect(state.cursor).toBe(1);
  expect(state.history).toEqual({ entries });
  expect(reduceTerminalInput(state, key("", { downArrow: true }), {}).state).toBe(state);
});

it("移动 cursor 使迟到 submitted 失效，不清稿、不记录历史", () => {
  const original: TerminalInputState = {
    draft: "待发送",
    revision: 3,
    history: { entries: ["旧提问"] },
  };
  const moved = reduceTerminalInput(original, key("", { leftArrow: true }), {}).state;
  expect(moved.revision).toBe(4);
  expect(
    reduceTerminalInput(
      moved,
      { type: "submitted", target: "draft", revision: 3, remember: true },
      {},
    ).state,
  ).toBe(moved);
  expect(moved.history).toBe(original.history);
});

it("审批导航冻结主稿，command 独立编辑/paste，Esc 或切换保留普通历史备份", () => {
  const state: TerminalInputState = Object.freeze({
    draft: "普通稿",
    cursor: 1,
    revision: 4,
    history: Object.freeze({
      entries: Object.freeze(["历史"]),
      index: 0,
      draft: Object.freeze({ text: "原草稿", cursor: 2 }),
    }),
  });
  for (const flags of [
    { leftArrow: true },
    { rightArrow: true },
    { home: true },
    { end: true },
    { upArrow: true },
    { downArrow: true },
  ]) {
    expect(reduceTerminalInput(state, key("", flags), { approvalId: "a" }).state).toBe(state);
  }
  let command = reduceTerminalInput(state, key("/steer y"), { approvalId: "a" }).state;
  command = reduceTerminalInput(command, key("", { leftArrow: true }), { approvalId: "a" }).state;
  expect(command.approvalCommand?.cursor).toBe("/steer ".length);
  const pasted = reduceTerminalInput(command, { type: "paste", text: "n\r" }, { approvalId: "a" });
  expect(pasted.state.approvalCommand?.text).toBe("/steer n\ry");
  expect(pasted.effects).toEqual([]);
  for (const [action, context] of [
    [key("", { escape: true }), { approvalId: "a" }],
    [key("y"), { approvalId: "b" }],
  ] as const) {
    const cleared = reduceTerminalInput(pasted.state, action, context).state;
    expect(cleared.approvalCommand).toBeUndefined();
    expect(cleared.draft).toBe(state.draft);
    expect(cleared.cursor).toBe(1);
    expect(cleared.history).toBe(state.history);
  }
  expect(state.history?.draft?.text).toBe("原草稿");
});

it("中段超限整段拒绝，保留 cursor、历史导航和 revision", () => {
  const state: TerminalInputState = Object.freeze({
    draft: "原稿",
    cursor: 1,
    revision: 3,
    history: Object.freeze({
      entries: Object.freeze(["历史"]),
      index: 0,
      draft: Object.freeze({ text: "备份", cursor: 1 }),
    }),
  });
  const result = reduceTerminalInput(state, { type: "paste", text: "😀".repeat(16384) }, {});
  expect(result.state).toBe(state);
  expect(result.effects).toEqual([expect.objectContaining({ type: "notice" })]);
});
