import { describe, expect, it } from "vitest";
import {
  describeRaceScenario,
  generateRaceScenario,
  mulberry32,
  RACE_ACTIONS,
  RACE_COUNTS,
  RACE_TIMINGS,
  type RaceAction,
  type RaceCount,
  type RaceTiming,
} from "./race-seeds.js";

describe("mulberry32（确定性 PRNG）", () => {
  it("同种子产生相同序列", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("不同种子产生不同序列", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("输出范围 [0, 1)", () => {
    const rng = mulberry32(7);
    for (let index = 0; index < 100; index += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("generateRaceScenario（组合矩阵）", () => {
  it("种子号确定性映射到 32 组合（动作 × 时机 × 次数）", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 32; seed += 1) {
      const scenario = generateRaceScenario(seed);
      const key = `${scenario.action}/${scenario.timing}/${scenario.count}`;
      seen.add(key);
      expect(scenario.seed).toBe(seed);
    }
    // 32 个种子覆盖全部组合（每组合恰好一次）
    expect(seen.size).toBe(32);
    for (const action of RACE_ACTIONS) {
      for (const timing of RACE_TIMINGS) {
        for (const count of RACE_COUNTS) {
          expect(seen.has(`${action}/${timing}/${count}`)).toBe(true);
        }
      }
    }
  });

  it("同种子可复现：延迟参数确定性", () => {
    const first = generateRaceScenario(123);
    const second = generateRaceScenario(123);
    expect(first).toEqual(second);
    // 延迟参数在合理范围内（确定性且不极端）
    expect(first.requestDelayMs).toBeGreaterThanOrEqual(0);
    expect(first.requestDelayMs).toBeLessThanOrEqual(100);
    expect(first.actionDelayMs).toBeGreaterThanOrEqual(0);
    expect(first.actionDelayMs).toBeLessThanOrEqual(150);
  });

  it("不同种子延迟参数不同（PRNG 派生）", () => {
    const delays = new Set<number>();
    for (let seed = 0; seed < 64; seed += 1) {
      delays.add(generateRaceScenario(seed).actionDelayMs);
    }
    expect(delays.size).toBeGreaterThan(4);
  });

  it("多次取消场景（count=multiple）有第二次延迟", () => {
    // 断言契约：multiple 组合存在且二次延迟在界内（具体组合映射由实现定）
    const found = new Array(32).fill(0).map((_, seed) => generateRaceScenario(seed));
    const multi = found.find((scenario) => scenario.count === "multiple");
    expect(multi?.secondActionDelayMs).toBeDefined();
    expect(multi!.secondActionDelayMs).toBeGreaterThanOrEqual(0);
    expect(multi!.secondActionDelayMs).toBeLessThanOrEqual(250);
  });
});

describe("describeRaceScenario（回放调试契约）", () => {
  it("输出含种子号与全部维度", () => {
    const scenario = generateRaceScenario(777);
    const text = describeRaceScenario(scenario);
    expect(text).toContain("777");
    expect(text).toContain(scenario.action);
    expect(text).toContain(scenario.timing);
    expect(text).toContain(scenario.count);
  });

  it("输出可回放：包含种子号可被 vitest -t 过滤", () => {
    const scenario = generateRaceScenario(0);
    const text = describeRaceScenario(scenario);
    expect(text).toMatch(/种子 \d+/);
  });
});

describe("维度常量", () => {
  it("四动作 / 四时机 / 两次数", () => {
    expect(RACE_ACTIONS).toEqual(["cancel", "timeout", "send", "dispose"]);
    expect(RACE_TIMINGS).toEqual(["streaming", "tool", "approval", "idle"]);
    expect(RACE_COUNTS).toEqual(["single", "multiple"]);
  });

  it("类型标签（品牌类型验证编译期约束）", () => {
    const action: RaceAction = "cancel";
    const timing: RaceTiming = "streaming";
    const count: RaceCount = "single";
    expect(`${action}/${timing}/${count}`).toBe("cancel/streaming/single");
  });
});
