const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { UserDatabase } = require("../src/database");
const { MemoryStore } = require("../src/memory-store");

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

// The production schema before this version, with a couple of rows
async function createOldDatabase(file) {
  const db = new sqlite3.Database(file);
  await runSql(db, `CREATE TABLE users (user_id TEXT PRIMARY KEY, first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_sent DATETIME DEFAULT CURRENT_TIMESTAMP, message_count INTEGER DEFAULT 1, first_reel_sent DATETIME,
    username TEXT, full_name TEXT, profile_pic TEXT, last_profile_update DATETIME)`);
  await runSql(db, `CREATE TABLE instagram_token (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL,
    expires_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runSql(db, "INSERT INTO users (user_id, message_count, first_reel_sent, username, full_name) VALUES (?, 640, '2025-11-08 17:34:40', 'marynaty6', 'Nati Ranz Perez')", ["2053012782302855"]);
  await runSql(db, "INSERT INTO instagram_token (id, access_token) VALUES (1, 'tok')");
  await new Promise((resolve) => db.close(resolve));
}

test("migrates an old users.db in place, additively, and twice without errors", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "users.db");
  await createOldDatabase(file);

  const first = new UserDatabase(file);
  await first.ready;
  await first.close();
  const db = new UserDatabase(file);
  await db.ready;

  const columns = (await db.all("PRAGMA table_info(users)")).map((c) => c.name);
  for (const name of ["user_id", "message_count", "first_reel_sent", "lang", "last_human_at", "is_verified_user", "profile_checked_at"]) {
    assert.ok(columns.includes(name), name);
  }
  const row = await db.get("SELECT * FROM users WHERE user_id = ?", ["2053012782302855"]);
  assert.equal(row.message_count, 640);
  assert.equal(row.full_name, "Nati Ranz Perez");
  assert.equal((await db.getInstagramToken()).access_token, "tok");
  await db.close();
});

test("sqlite store and memory store behave the same", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sqlite = new UserDatabase(path.join(dir, "users.db"));
  const memory = new MemoryStore();
  const now = Date.parse("2026-05-01T12:00:00Z");

  const results = [];
  for (const store of [sqlite, memory]) {
    await store.recordRecipe("u", now - 8 * 86400000);
    await store.recordRecipe("u", now - 1000);
    await store.applyUpdate("u", "live", { lastFreeTextAt: now - 5000, lang: "ca", level: 2, level1SentAt: now - 86400000, lastLevel2Variant: 3 });
    await store.applyUpdate("u", "shadow", { level: 1 });
    await store.recordBotMessage("mid.1", "u", "level1", now);
    await store.saveProfile("u", { name: "Ausen Perez", username: "ausenperez", followerCount: 120, isBusinessFollowUser: false, isVerifiedUser: true }, now);
    results.push({
      live: await store.getState("u", "live", now),
      shadow: await store.getState("u", "shadow", now),
      ours: await store.isBotMessage("mid.1"),
      notOurs: await store.isBotMessage("mid.2"),
      profile: (await store.getCachedProfile("u")).profile.isVerifiedUser,
    });
  }
  await sqlite.close();
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].live.recipesLast7Days, 1);
  assert.equal(results[0].live.lang, "ca");
  assert.equal(results[0].shadow.level, 1);
  assert.equal(results[0].shadow.lang, "ca");
});

test("Remy bridge tables: sqlite and memory store behave the same", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sqlite = new UserDatabase(path.join(dir, "users.db"));
  const memory = new MemoryStore();
  const now = Date.parse("2026-11-16T10:00:00Z");

  const results = [];
  for (const store of [sqlite, memory]) {
    await store.recordRemyMessage("mid.remy.1", "u", now);
    const added = [];
    for (const [eventId, at] of [["a", now - 50 * 3600000], ["b", now - 1000], ["a", now], ["c", now]]) {
      added.push(await store.outboxAdd({ eventId, account: "acc", payload: JSON.stringify({ id: eventId }), createdAt: at }));
    }
    const head = await store.outboxHead(2);
    await store.outboxFailed(head.map((r) => r.id), now + 10000, "HTTP 502");
    const afterFail = (await store.outboxHead(10)).map(({ id, ...rest }) => rest);
    const stats = await store.outboxStats();
    const dropped = await store.outboxDropOlderThan(now - 48 * 3600000);
    const remaining = (await store.outboxHead(10)).map((r) => r.eventId);
    await store.outboxDelete((await store.outboxHead(1)).map((r) => r.id));
    await store.saveIdempotentAnswer("k1", 200, { messageIds: ["m1"] }, now);
    await store.saveIdempotentAnswer("old", 200, { messageIds: ["m0"] }, now - 25 * 3600000);
    await store.saveProfile("u", { name: "Ana", username: "ana", profilePic: "https://cdn.test/ana.jpg", followerCount: 3, isBusinessFollowUser: false, isVerifiedUser: false, isUserFollowBusiness: true }, now);
    results.push({
      remy: await store.isRemyMessage("mid.remy.1"),
      notRemy: await store.isRemyMessage("mid.other"),
      added,
      afterFail,
      stats,
      dropped,
      remaining,
      left: (await store.outboxHead(10)).map((r) => r.eventId),
      idem: await store.getIdempotentAnswer("k1", now + 1000),
      expired: await store.getIdempotentAnswer("k1", now + 25 * 3600000),
      old: await store.getIdempotentAnswer("old", now),
      pic: (await store.getCachedProfile("u")).profile.profilePic,
    });
  }
  await sqlite.close();
  assert.deepEqual(results[0], results[1]);
  const r = results[0];
  assert.deepEqual(r.added, [true, true, false, true]);
  assert.deepEqual(r.afterFail.map((x) => [x.eventId, x.attempts, x.lastError]), [["a", 1, "HTTP 502"], ["b", 1, "HTTP 502"], ["c", 0, null]]);
  assert.deepEqual(r.stats, { queued: 3, oldestAt: now - 50 * 3600000, lastError: "HTTP 502" });
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.remaining, ["b", "c"]);
  assert.deepEqual(r.left, ["c"]);
  assert.deepEqual(r.idem, { status: 200, body: { messageIds: ["m1"] } });
  assert.equal(r.expired, null);
  assert.equal(r.pic, "https://cdn.test/ana.jpg");
});

test("a users row with no profile in it is not a cached profile for Remy", async (t) => {
  const { Responder } = require("../src/responder");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UserDatabase(path.join(dir, "users.db"));
  await store.recordEcho("900"); // creates the row, nothing about the person
  const responder = new Responder({ store, profiles: {}, sender: {}, notifier: {}, logger: { log() {}, error() {} } });
  assert.equal(await responder.cachedProfile("900"), null);
  await store.saveProfile("900", { name: "Ana", username: "ana" }, Date.now());
  assert.equal((await responder.cachedProfile("900")).username, "ana");
  await store.close();
});
