export interface TerminalInputState {
  readonly draft: string;
  readonly cursor?: number;
  readonly approvalCommand?: {
    readonly approvalId: string;
    readonly text: string;
    readonly cursor?: number;
  };
  readonly history?: {
    readonly entries: readonly string[];
    readonly index?: number;
    readonly draft?: { readonly text: string; readonly cursor: number };
  };
  readonly revision: number;
}

export type TerminalInputAction =
  | {
      type: "key";
      text: string;
      key: {
        return: boolean;
        escape: boolean;
        backspace: boolean;
        ctrl: boolean;
        leftArrow?: boolean;
        rightArrow?: boolean;
        home?: boolean;
        end?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
      };
    }
  | { type: "paste"; text: string }
  | {
      type: "submitted";
      revision: number;
      target: "draft" | "approval-command";
      remember?: boolean;
    };

export type TerminalInputEffect =
  | { type: "submit"; text: string; revision: number; target: "draft" | "approval-command" }
  | { type: "approval"; approvalId: string; decision: "allow" | "deny" }
  | { type: "notice"; text: string };

type InputResult = { state: TerminalInputState; effects: readonly TerminalInputEffect[] };
type Target = "draft" | "approval-command";
const MAX_GRAPHEMES = 16_384;
const MAX_BYTES = 65_536;
const MAX_HISTORY_ENTRIES = 50;
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 只编辑稿件并发出同步候选；真正准入、审批和异步操作仍由唯一输入所有者处理。 */
export function reduceTerminalInput(
  state: TerminalInputState,
  action: TerminalInputAction,
  context: { approvalId?: string },
): InputResult {
  if (state.approvalCommand && state.approvalCommand.approvalId !== context.approvalId) {
    return notice(clearCommand(state), "审批已切换，旧命令已取消；原稿已保留。");
  }
  if (action.type === "submitted") {
    if (action.revision !== state.revision) return unchanged(state);
    if (action.target === "approval-command") {
      return unchanged(state.approvalCommand ? clearCommand(state) : state);
    }
    if (!state.draft) return unchanged(state);
    const next = replace(state, "draft", "", 0);
    const text = state.draft.trim();
    const remember = action.remember === true && text.length > 0 && !text.startsWith("/");
    if (!state.history && !remember) return unchanged(next);
    const previous = state.history?.entries ?? [];
    const entries =
      remember && previous.at(-1) !== text
        ? [...previous, text].slice(-MAX_HISTORY_ENTRIES)
        : previous;
    return unchanged({ ...next, history: { entries } });
  }
  if (action.type === "paste") {
    if (!action.text) return unchanged(state);
    return insert(
      state,
      action.text,
      context.approvalId ? "approval-command" : "draft",
      context.approvalId,
    );
  }
  if (action.key.ctrl) return unchanged(state);
  if (state.approvalCommand) {
    if (action.key.escape) return unchanged(clearCommand(state));
    return editKey(state, action, "approval-command", context.approvalId);
  }
  if (context.approvalId) {
    if (isNavigation(action.key)) return unchanged(state);
    if (action.key.escape || independentEnter(action))
      return approval(state, context.approvalId, "deny");
    if (action.key.backspace) return unchanged(state);
    if (!action.key.return && /^[yYnN]$/u.test(action.text)) {
      return approval(
        state,
        context.approvalId,
        action.text.toLowerCase() === "y" ? "allow" : "deny",
      );
    }
    if (action.text.startsWith("/"))
      return editKey(state, action, "approval-command", context.approvalId);
    return action.text ? notice(state, "请单独按 y/n；控制命令请以 / 开头。") : unchanged(state);
  }
  if (action.key.escape) return unchanged(state);
  return editKey(state, action, "draft");
}

function editKey(
  state: TerminalInputState,
  action: Extract<TerminalInputAction, { type: "key" }>,
  target: Target,
  approvalId?: string,
): InputResult {
  if (action.key.upArrow || action.key.downArrow) {
    return target === "draft" ? recall(state, action.key.upArrow ? -1 : 1) : unchanged(state);
  }
  const current = target === "draft" ? state.draft : (state.approvalCommand?.text ?? "");
  const cursor = terminalInputCursor(
    current,
    target === "draft" ? state.cursor : state.approvalCommand?.cursor,
  );
  if (isNavigation(action.key)) {
    const position = action.key.home
      ? 0
      : action.key.end
        ? current.length
        : action.key.leftArrow
          ? adjacentCursor(current, cursor, -1)
          : adjacentCursor(current, cursor, 1);
    return unchanged(replace(state, target, current, position, approvalId));
  }
  if (action.key.backspace) {
    const previous = adjacentCursor(current, cursor, -1);
    return unchanged(
      replace(
        state,
        target,
        current.slice(0, previous) + current.slice(cursor),
        previous,
        approvalId,
      ),
    );
  }
  const terminator = action.text.endsWith("\r\n")
    ? 2
    : action.text.endsWith("\r") || (action.key.return && action.text.endsWith("\n"))
      ? 1
      : 0;
  const text = terminator ? action.text.slice(0, -terminator) : action.text;
  const submit = !/[\r\n]/u.test(text) && (terminator > 0 || action.key.return);
  const result = insert(state, submit ? text : action.text, target, approvalId);
  if (result.effects.length || !submit) return result;
  const candidate =
    target === "draft" ? result.state.draft : (result.state.approvalCommand?.text ?? "");
  return candidate.trim()
    ? {
        state: result.state,
        effects: [{ type: "submit", text: candidate, revision: result.state.revision, target }],
      }
    : result;
}

function insert(
  state: TerminalInputState,
  text: string,
  target: Target,
  approvalId?: string,
): InputResult {
  // 先拒绝超大单段，组合候选最多只有两份固定上限稿件，不保留无界缓冲。
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return oversized(state);
  const current = target === "draft" ? state.draft : (state.approvalCommand?.text ?? "");
  const cursor = terminalInputCursor(
    current,
    target === "draft" ? state.cursor : state.approvalCommand?.cursor,
  );
  const combined = current.slice(0, cursor) + text + current.slice(cursor);
  if (Buffer.byteLength(combined, "utf8") > MAX_BYTES) return oversized(state);
  let count = 0;
  for (const _part of segmenter.segment(combined)) {
    if (++count > MAX_GRAPHEMES) return oversized(state);
  }
  return unchanged(replace(state, target, combined, cursor + text.length, approvalId));
}

function replace(
  state: TerminalInputState,
  target: Target,
  text: string,
  offset: number,
  approvalId?: string,
): TerminalInputState {
  const cursor = terminalInputCursor(text, offset);
  const position = cursor === text.length ? {} : { cursor };
  if (target === "draft") {
    if (text === state.draft && cursor === terminalInputCursor(state.draft, state.cursor))
      return state;
    const { cursor: _cursor, ...rest } = state;
    return { ...rest, draft: text, ...position, revision: state.revision + 1 };
  }
  const command = state.approvalCommand;
  if (
    command &&
    command.approvalId === approvalId &&
    command.text === text &&
    cursor === terminalInputCursor(command.text, command.cursor)
  )
    return state;
  return {
    ...state,
    revision: state.revision + 1,
    approvalCommand: { approvalId: approvalId!, text, ...position },
  };
}

/** cursor 使用 UTF-16 offset，但始终向右吸附到完整字素边界；缺省为末尾。 */
export function terminalInputCursor(text: string, offset = text.length): number {
  const wanted = Math.max(0, Math.min(text.length, offset));
  if (wanted === 0 || wanted === text.length) return wanted;
  for (const part of segmenter.segment(text)) if (part.index >= wanted) return part.index;
  return text.length;
}

function adjacentCursor(text: string, cursor: number, direction: -1 | 1): number {
  if ((direction === -1 && cursor === 0) || (direction === 1 && cursor === text.length))
    return cursor;
  let previous = 0;
  for (const part of segmenter.segment(text)) {
    if (direction === 1 && part.index > cursor) return part.index;
    if (direction === -1 && part.index >= cursor) return previous;
    previous = part.index;
  }
  return direction === 1 ? text.length : previous;
}

function recall(state: TerminalInputState, direction: -1 | 1): InputResult {
  const history = state.history;
  if (!history?.entries.length) return unchanged(state);
  if (direction === 1 && history.index === undefined) return unchanged(state);
  if (direction === -1 && history.index === 0) return unchanged(state);
  const snapshot = history.draft ?? {
    text: state.draft,
    cursor: terminalInputCursor(state.draft, state.cursor),
  };
  const index =
    history.index === undefined ? history.entries.length - 1 : history.index + direction;
  if (index === history.entries.length) {
    const next = replace(state, "draft", snapshot.text, snapshot.cursor);
    return unchanged({
      ...next,
      revision: state.revision + 1,
      history: { entries: history.entries },
    });
  }
  const text = history.entries[index]!;
  const next = replace(state, "draft", text, text.length);
  return unchanged({
    ...next,
    revision: state.revision + 1,
    history: { entries: history.entries, index, draft: snapshot },
  });
}

function isNavigation(key: Extract<TerminalInputAction, { type: "key" }>["key"]): boolean {
  return Boolean(
    key.leftArrow || key.rightArrow || key.home || key.end || key.upArrow || key.downArrow,
  );
}

function independentEnter(action: Extract<TerminalInputAction, { type: "key" }>): boolean {
  return (action.key.return && !action.text) || /^(?:\r|\r\n|\n)$/u.test(action.text);
}

function clearCommand(state: TerminalInputState): TerminalInputState {
  const { approvalCommand: _command, ...rest } = state;
  return { ...rest, revision: state.revision + 1 };
}

function approval(
  state: TerminalInputState,
  approvalId: string,
  decision: "allow" | "deny",
): InputResult {
  return { state, effects: [{ type: "approval", approvalId, decision }] };
}

function unchanged(state: TerminalInputState): InputResult {
  return { state, effects: [] };
}

function oversized(state: TerminalInputState): InputResult {
  return notice(state, "输入超过上限，整段未保存；原稿已保留。");
}

function notice(state: TerminalInputState, text: string): InputResult {
  return { state, effects: [{ type: "notice", text }] };
}
