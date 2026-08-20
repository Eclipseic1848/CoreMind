/**
 * 取消竞态种子矩阵（规格 docs/spec/0.3.x-a/04-acceptance-matrix.md 门 C-1）。
 *
 * 确定性 PRNG 固定种子生成 1,000 个竞态场景，组合维度：
 * 动作（cancel / timeout / send / dispose）× 时机（流式进行中 / 工具执行中 /
 * 审批挂起中 / idle 后）× 次数（单次 / 多次）。
 *
 * 同一种子永远生成同一场景（含全部延迟参数），失败种子可按种子号回放
 * （vitest -t "种子 N" 即最小复现用例，调试契约）。
 */

/** 竞态动作：外部取消请求 / 超时终止 / 新输入（abort 后立刻 send）/ 实例处置 */
export type RaceAction = "cancel" | "timeout" | "send" | "dispose";
/** 竞态时机：动作触发时 run 所处的活动阶段 */
export type RaceTiming = "streaming" | "tool" | "approval" | "idle";
/** 触发次数：单次 / 多次（多次取消、多次 send 等） */
export type RaceCount = "single" | "multiple";

export const RACE_ACTIONS = ["cancel", "timeout", "send", "dispose"] as const;
export const RACE_TIMINGS = ["streaming", "tool", "approval", "idle"] as const;
export const RACE_COUNTS = ["single", "multiple"] as const;

/** 一个确定性竞态场景：种子号 + 组合维度 + PRNG 派生的延迟参数 */
export interface RaceScenario {
  seed: number;
  action: RaceAction;
  timing: RaceTiming;
  count: RaceCount;
  /** mock Provider 请求响应延迟（流式时长，ms） */
  requestDelayMs: number;
  /** 动作触发延迟（相对请求录制确认，ms） */
  actionDelayMs: number;
  /** 多次触发时第二次动作延迟（相对第一次，ms） */
  secondActionDelayMs: number;
}

/** mulberry32 确定性 PRNG：同种子同序列，输出 [0, 1) */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从种子号生成确定性场景：index = seed % 32 映射到组合矩阵
 * （action = index/8、timing = index/2、count = index 的奇偶），
 * 延迟参数由 mulberry32(seed) 派生（确定性、可复现）。
 */
export function generateRaceScenario(seed: number): RaceScenario {
  const index = seed % (RACE_ACTIONS.length * RACE_TIMINGS.length * RACE_COUNTS.length);
  const action = RACE_ACTIONS[Math.floor(index / (RACE_TIMINGS.length * RACE_COUNTS.length))]!;
  const timing = RACE_TIMINGS[Math.floor(index / RACE_COUNTS.length) % RACE_TIMINGS.length]!;
  const count = RACE_COUNTS[index % RACE_COUNTS.length]!;
  const rng = mulberry32(seed);
  return {
    seed,
    action,
    timing,
    count,
    // 延迟上界：1,000 种子全量执行的总时长预算（每种子 ~200ms → ~4 分钟）
    requestDelayMs: Math.floor(rng() * 100),
    actionDelayMs: Math.floor(rng() * 150),
    secondActionDelayMs: Math.floor(rng() * 250),
  };
}

/** 场景的人类可读描述（测试失败输出与回放过滤用） */
export function describeRaceScenario(scenario: RaceScenario): string {
  return (
    `种子 ${scenario.seed}（${scenario.action} × ${scenario.timing} × ${scenario.count}，` +
    `请求延迟 ${scenario.requestDelayMs}ms / 动作延迟 ${scenario.actionDelayMs}ms` +
    `${scenario.count === "multiple" ? ` / 二次延迟 ${scenario.secondActionDelayMs}ms` : ""}）`
  );
}
