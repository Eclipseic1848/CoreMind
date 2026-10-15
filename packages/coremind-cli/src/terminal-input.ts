export interface TerminalInputState {
  readonly draft: string;
  readonly approvalCommand?: { readonly approvalId: string; readonly text: string };
  readonly revision: number;
}

export type TerminalInputAction =
  | {
      type: "key";
      text: string;
      key: { return: boolean; escape: boolean; backspace: boolean; ctrl: boolean };
    }
  | { type: "paste"; text: string }
  | { type: "submitted"; revision: number; target: "draft" | "approval-command" };

export type TerminalInputEffect =
  | { type: "submit"; text: string; revision: number; target: "draft" | "approval-command" }
  | { type: "approval"; approvalId: string; decision: "allow" | "deny" }
  | { type: "notice"; text: string };

type InputResult = { state: TerminalInputState; effects: readonly TerminalInputEffect[] };
type Target = "draft" | "approval-command";
const MAX_GRAPHEMES = 16_384;
const MAX_BYTES = 65_536;
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
    return unchanged(state.draft ? { ...state, draft: "", revision: state.revision + 1 } : state);
  }
  if (action.type === "paste") {
    if (!action.text) return unchanged(state);
    return append(
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
  const current = target === "draft" ? state.draft : (state.approvalCommand?.text ?? "");
  if (action.key.backspace)
    return unchanged(replace(state, target, removeLast(current), approvalId));
  const terminator = action.text.endsWith("\r\n")
    ? 2
    : action.text.endsWith("\r") || (action.key.return && action.text.endsWith("\n"))
      ? 1
      : 0;
  const text = terminator ? action.text.slice(0, -terminator) : action.text;
  const submit = !/[\r\n]/u.test(text) && (terminator > 0 || action.key.return);
  const result = append(state, submit ? text : action.text, target, approvalId);
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

function append(
  state: TerminalInputState,
  text: string,
  target: Target,
  approvalId?: string,
): InputResult {
  // 先拒绝超大单段，组合候选最多只有两份固定上限稿件，不保留无界缓冲。
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return oversized(state);
  const current = target === "draft" ? state.draft : (state.approvalCommand?.text ?? "");
  const combined = current + text;
  if (Buffer.byteLength(combined, "utf8") > MAX_BYTES) return oversized(state);
  let count = 0;
  for (const _part of segmenter.segment(combined)) {
    if (++count > MAX_GRAPHEMES) return oversized(state);
  }
  return unchanged(replace(state, target, combined, approvalId));
}

function replace(
  state: TerminalInputState,
  target: Target,
  text: string,
  approvalId?: string,
): TerminalInputState {
  if (target === "draft")
    return text === state.draft ? state : { ...state, draft: text, revision: state.revision + 1 };
  if (state.approvalCommand?.approvalId === approvalId && state.approvalCommand?.text === text)
    return state;
  return {
    ...state,
    revision: state.revision + 1,
    approvalCommand: { approvalId: approvalId!, text },
  };
}

function removeLast(value: string): string {
  let last = 0;
  for (const part of segmenter.segment(value)) last = part.index;
  return value.slice(0, last);
}

function independentEnter(action: Extract<TerminalInputAction, { type: "key" }>): boolean {
  return (action.key.return && !action.text) || /^(?:\r|\r\n|\n)$/u.test(action.text);
}

function clearCommand(state: TerminalInputState): TerminalInputState {
  return { draft: state.draft, revision: state.revision + 1 };
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
