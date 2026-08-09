import assert from "node:assert/strict";
import test from "node:test";
import { finalPrice } from "../src/discount.ts";

test("八折后 100 元商品应为 80 元", () => {
  assert.equal(finalPrice(100, 0.2), 80);
});
