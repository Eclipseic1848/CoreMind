import assert from "node:assert/strict";
import test from "node:test";
import { finalPrice } from "../src/discount.ts";

test("零折扣保持原价", () => {
  assert.equal(finalPrice(59, 0), 59);
});

test("全额折扣结果为零", () => {
  assert.equal(finalPrice(59, 1), 0);
});
