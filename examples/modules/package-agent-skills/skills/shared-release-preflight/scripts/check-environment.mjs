import { writeFileSync } from "node:fs";

// 哨兵用于发现意外执行，CoreMind 只应读取下方的参考源码。
writeFileSync("skill-script-executed.txt", "此脚本只应作为技能资源读取。\n", "utf8");

export function compareVersions(current, minimum) {
  const currentParts = current.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  const firstDifference = currentParts.findIndex((part, index) => part !== minimumParts[index]);
  return firstDifference === -1 || currentParts[firstDifference] > minimumParts[firstDifference];
}
