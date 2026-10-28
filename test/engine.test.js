const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, firstNameFrom, classifyEcho, MINUTE, DAY } = require("../src/engine");

const NOW = Date.parse("2026-05-01T12:00:00Z");
const base = (extra = {}) => ({ userId: "u", level: 0, profileStatus: "ok", profile: { name: null }, recipesLast7Days: 1, ...extra });
const reel = (extra = {}) => ({ type: "recipe", source: "share", at: NOW - MINUTE, ...extra });

test("decide is pure: same input, same output, state untouched", () => {
  const state = base();
  const frozen = JSON.stringify(state);
  const a = decide(state, reel(), NOW);
  const b = decide(state, reel(), NOW);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(state), frozen);
});

test("first reel ever -> level 1; old users (no level 1 under this version) too", () => {
  assert.equal(decide(base(), reel(), NOW).kind, "level1");
  assert.equal(decide(base({ lastRecipeAt: NOW - 3 * DAY }), reel(), NOW).kind, "level1");
});

test("rule order: burst before conversation rules (no Telegram for every reel of a burst)", () => {
  const action = decide(base({ lastRecipeAt: NOW - 90 * 1000, lastHumanAt: NOW - DAY }), reel(), NOW);
  assert.equal(action.reason, "burst");
  assert.equal(action.notify, null);
});

test("a human answer after the free text clears the 24 h rule (but the 14-day rule applies)", () => {
  const action = decide(base({ lastFreeTextAt: NOW - 2 * DAY + 0, lastHumanAt: NOW - 20 * DAY }), reel(), NOW);
  assert.equal(action.kind, "level1");
});

test("every decision records the reel time for the burst and 30-day rules", () => {
  const action = decide(base({ lastHumanAt: NOW - DAY }), reel({ lastAt: NOW - 10 * 1000 }), NOW);
  assert.equal(action.update.lastRecipeAt, NOW - 10 * 1000);
});

test("free text updates the state and notifies, never replies", () => {
  const action = decide(base(), { type: "text", text: "hola", lang: "ca", at: NOW }, NOW);
  assert.equal(action.type, "none");
  assert.deepEqual(action.update, { lastFreeTextAt: NOW, lang: "ca" });
  assert.deepEqual(action.notify, { type: "message" });
});

test("first name only when it looks like a real name", () => {
  assert.equal(firstNameFrom("Nati Ranz Perez"), "Nati");
  assert.equal(firstNameFrom("Gloria Carrión (La Gloria Vegana)"), "Gloria");
  assert.equal(firstNameFrom("pepi Mas Julia"), "Pepi");
  assert.equal(firstNameFrom("🌸 Laura López"), "Laura");
  assert.equal(firstNameFrom("FÉNIX"), null);
  assert.equal(firstNameFrom("Cocina con Ana"), null);
  assert.equal(firstNameFrom("sweet_home 12"), null);
  assert.equal(firstNameFrom("Toñi de la Torre"), "Toñi");
  assert.equal(firstNameFrom(""), null);
  assert.equal(firstNameFrom(null), null);
});

test("echo classification by mid", () => {
  assert.equal(classifyEcho("mid.1", true), "bot");
  assert.equal(classifyEcho("mid.2", false), "human");
  assert.equal(classifyEcho(undefined, false), "human");
});
