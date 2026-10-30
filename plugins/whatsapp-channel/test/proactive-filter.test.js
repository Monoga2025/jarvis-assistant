import { test } from "node:test";
import assert from "node:assert/strict";
import { createProactiveFilter } from "../proactive-filter.js";

const setup = () => {
  let state = {};
  let t = Date.parse("2026-01-01T00:00:00Z");
  const f = createProactiveFilter({ read: () => state, write: (s) => { state = s; } }, () => t);
  return { f, advance: (h) => { t += h * 3600000; }, get: () => state };
};

test("first send is allowed, repeat within cooldown is blocked", () => {
  const { f, advance } = setup();
  assert.equal(f.shouldSend("saldo_critico", "x").allow, true);
  f.logSent("saldo_critico", "x");
  advance(1);
  assert.equal(f.shouldSend("saldo_critico", "y").allow, false);
});

test("identical content is blocked inside 12h even if the cooldown elapsed", () => {
  const { f, advance } = setup();
  f.logSent("spike_gasto", "same");
  advance(2);
  assert.equal(f.shouldSend("spike_gasto", "same").reason, "same-content");
  assert.equal(f.shouldSend("spike_gasto", "different").allow, true);
});

test("unknown types use the 4h default and the log is capped", () => {
  const { f, advance, get } = setup();
  f.logSent("custom", "a");
  advance(5);
  assert.equal(f.shouldSend("custom", "b").allow, true);
  for (let i = 0; i < 150; i++) f.logSent("t" + i, "c");
  assert.ok(get().proactive_log.length <= 100);
});

test("crisis mode flag is read from state", () => {
  let state = { crisis_mode: { active: true } };
  const f = createProactiveFilter({ read: () => state, write: (s) => { state = s; } });
  assert.equal(f.isCrisisModeActive(), true);
});
