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
