// Outbox to Remy: ids, order, batches, backoff, dedupe, give-up (fake clock, fake HTTP)
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RemyBridge, eventId, toRemyProfile } = require("../src/remy-bridge");
const { MemoryStore } = require("../src/memory-store");
const { VirtualTime } = require("../scripts/lib/virtual-time");
const { verify } = require("../src/remy-signature");

const SECRET = "bridge-secret";
const ACCOUNT = "17841473716984633";
const START = Date.parse("2026-11-16T10:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function fakeRemy(time, { up = () => true } = {}) {
  const posts = [];
  const accepted = [];
  return {
    posts,
    accepted,
    post: async (url, body, headers) => {
      const check = verify({ secret: SECRET, timestamp: headers["X-Bridge-Timestamp"], signature: headers["X-Bridge-Signature"], rawBody: body, nowMs: time.now() });
      const payload = JSON.parse(body);
      posts.push({ at: time.now(), url, payload, signed: check.ok });
      const state = up(posts.length);
      if (state === "throw") throw new Error("connect ECONNREFUSED 192.168.5.3:443");
      if (state !== true) return { status: typeof state === "number" ? state : 503 };
      accepted.push(...payload.events);
      return { status: 202 };
    },
  };
}

function makeBridge({ up, store = new MemoryStore() } = {}) {
  const time = new VirtualTime(START);
  const remy = fakeRemy(time, { up });
  const telegram = [];
  const bridge = new RemyBridge({
    store,
    url: "https://remy.test/api/public/instagram/" + ACCOUNT,
    secret: SECRET,
    account: ACCOUNT,
    post: remy.post,
    clock: time,
    scheduler: time,
    notify: async (text) => telegram.push({ at: time.now(), text }),
    logger: { log() {}, error() {} },
  });
  return { time, remy, telegram, bridge, store };
}

const message = (n, extra = {}) => ({ sender: { id: "9001" }, recipient: { id: ACCOUNT }, timestamp: START + n, message: { mid: `mid.${n}`, text: `m${n}`, ...extra } });

test("id scheme: mid, deleted:, edit:, reaction:, read:, <kind>:<sha1>", () => {
  const base = { sender: { id: "9001" }, recipient: { id: ACCOUNT }, timestamp: 1763287200000 };
  assert.equal(eventId({ ...base, message: { mid: "aWdf1", text: "hola" } }), "aWdf1");
  assert.equal(eventId({ ...base, message: { mid: "aWdf1", text: "hola", is_echo: true } }), "aWdf1");
  assert.equal(eventId({ ...base, message: { mid: "aWdf1", is_unsupported: true } }), "aWdf1");
  assert.equal(eventId({ ...base, message: { mid: "aWdf1", is_deleted: true } }), "deleted:aWdf1");
  assert.equal(eventId({ ...base, message_edit: { mid: "aWdf1", text: "hola!", num_edit: 1 } }), "edit:aWdf1:1763287200000");
  assert.equal(eventId({ ...base, reaction: { mid: "aWdf1", action: "react", reaction: "love", emoji: "❤" } }), "reaction:aWdf1:react:1763287200000");
  assert.equal(eventId({ ...base, reaction: { mid: "aWdf1", action: "unreact" } }), "reaction:aWdf1:unreact:1763287200000");
  assert.equal(eventId({ ...base, read: { mid: "aWdf1" } }), "read:aWdf1:1763287200000");
  assert.equal(eventId({ ...base, read: { watermark: 1763287100000 } }), "read:1763287100000:1763287200000");
  const postback = { ...base, postback: { title: "Empezar", payload: "START" } };
  const sha1 = crypto.createHash("sha1").update(JSON.stringify(postback)).digest("hex");
  assert.equal(eventId(postback), `postback:${sha1}`);
  assert.equal(eventId(postback), eventId(JSON.parse(JSON.stringify(postback))), "stable");
});

test("profile shape for Remy", () => {
  assert.deepEqual(toRemyProfile("9001", { name: "Ana", username: "ana", followerCount: 3, isVerifiedUser: false, isUserFollowBusiness: true, isBusinessFollowUser: false, profilePic: "https://cdn.test/a.jpg" }), {
    igsid: "9001",
    username: "ana",
    name: "Ana",
    followerCount: 3,
    isVerifiedUser: false,
    isUserFollowBusiness: true,
    isBusinessFollowUser: false,
    profilePic: "https://cdn.test/a.jpg",
  });
  assert.equal(toRemyProfile("9001", null), null);
});

test("signed POST with {account, sentAt, events[{id, event, origin, bot, profile}]}", async () => {
  const { time, remy, bridge } = makeBridge();
  bridge.start();
  const event = message(1);
  bridge.enqueue({ event, origin: "user", bot: { classified: "text", decision: "silent", kind: null, reason: "free_text" }, profile: null });
  await bridge.settled();
  await time.runAll();
  assert.equal(remy.posts.length, 1);
  assert.equal(remy.posts[0].signed, true);
  assert.equal(remy.posts[0].url, "https://remy.test/api/public/instagram/" + ACCOUNT);
  assert.deepEqual(remy.posts[0].payload, {
    account: ACCOUNT,
    sentAt: new Date(START).toISOString(),
    events: [{ id: "mid.1", event, origin: "user", bot: { classified: "text", decision: "silent", kind: null, reason: "free_text" }, profile: null }],
  });
});

test("batches of at most 50, in order; an event queued twice is sent once", async () => {
  const { time, remy, bridge } = makeBridge();
  for (let n = 1; n <= 120; n++) bridge.enqueue({ event: message(n), origin: "user", bot: null, profile: null });
  bridge.enqueue({ event: message(7), origin: "user", bot: null, profile: null }); // Meta retried the webhook
  await bridge.settled();
  bridge.start();
  await time.runAll();
  assert.deepEqual(remy.posts.map((p) => p.payload.events.length), [50, 50, 20]);
  assert.deepEqual(remy.accepted.map((e) => e.id), Array.from({ length: 120 }, (_, i) => `mid.${i + 1}`));
});

test("items given as promises keep their call order; a failing one is skipped, never thrown", async () => {
  const { time, remy, bridge } = makeBridge();
  bridge.start();
  const slow = new Promise((resolve) => setTimeout(() => resolve({ event: message(1), origin: "user" }), 20));
  const failing = Promise.reject(new Error("profile lookup exploded"));
  bridge.enqueue(slow);
  bridge.enqueue(failing);
  bridge.enqueue({ event: message(2), origin: "user" });
  await bridge.settled();
  await time.runAll();
  assert.deepEqual(remy.accepted.map((e) => e.id), ["mid.1", "mid.2"]);
});

test("a broken outbox store never throws into the caller", async () => {
  const store = new MemoryStore();
  store.outboxAdd = async () => {
    throw new Error("SQLITE_FULL");
  };
  const { bridge } = makeBridge({ store });
  assert.doesNotThrow(() => bridge.enqueue({ event: message(1), origin: "user" }));
  await bridge.settled();
});

test("Remy down: retries after 10 s, doubling up to 30 min, then drains in order", async () => {
  const failures = 12;
  const { time, remy, bridge } = makeBridge({ up: (n) => (n <= failures ? (n % 2 ? 503 : "throw") : true) });
  bridge.start();
  bridge.enqueue({ event: message(1), origin: "user" });
  await bridge.settled();
  await time.advanceBy(0);
  // A new event while waiting does not jump the queue nor the backoff
  await time.advanceBy(5 * SECOND);
  bridge.enqueue({ event: message(2), origin: "user" });
  await bridge.settled();
  await time.runAll();

  const gaps = remy.posts.slice(1).map((p, i) => (p.at - remy.posts[i].at) / SECOND);
  assert.deepEqual(gaps, [10, 20, 40, 80, 160, 320, 640, 1280, 1800, 1800, 1800, 1800]);
  assert.deepEqual(remy.posts[0].payload.events.map((e) => e.id), ["mid.1"]);
  assert.deepEqual(remy.posts[1].payload.events.map((e) => e.id), ["mid.1", "mid.2"]);
  assert.deepEqual(remy.accepted.map((e) => e.id), ["mid.1", "mid.2"]);
  const health = await bridge.health();
  assert.equal(health.queued, 0);
  assert.equal(health.lastError, null);
  assert.equal(health.lastOkAt, new Date(remy.posts.at(-1).at).toISOString());
});

test("after 48 h an event is dropped with ONE Telegram line; Remy back drains the rest", async () => {
  let remyUp = false;
  const { time, remy, telegram, bridge } = makeBridge({ up: () => (remyUp ? true : 502) });
  bridge.start();
  bridge.enqueue({ event: message(1), origin: "user" });
  await bridge.settled();
  await time.advanceBy(30 * HOUR);
  bridge.enqueue({ event: message(2), origin: "user" });
  await bridge.settled();
  await time.advanceBy(5 * HOUR);
  bridge.enqueue({ event: message(3), origin: "user" });
  await bridge.settled();

  const midHealth = await bridge.health();
  assert.equal(midHealth.queued, 3);
  assert.equal(midHealth.oldestAt, new Date(START).toISOString());
  assert.equal(midHealth.lastError, "HTTP 502");

  await time.advanceTo(START + 49 * HOUR);
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /^⚠️ Remy bridge: 1 Instagram events could not be delivered to Remy in 48 h/);
  assert.ok(telegram[0].at >= START + 48 * HOUR && telegram[0].at <= START + 48 * HOUR + 30 * MINUTE);

  await time.advanceTo(START + 80 * HOUR); // mid.2 is now older than 48 h too: dropped, no second line
  assert.equal(telegram.length, 1);
  assert.equal((await bridge.health()).queued, 1);

  remyUp = true;
  await time.advanceBy(31 * MINUTE);
  assert.deepEqual(remy.accepted.map((e) => e.id), ["mid.3"]);

  // A later outage gets its own line
  remyUp = false;
  bridge.enqueue({ event: message(4), origin: "user" });
  await bridge.settled();
  await time.advanceBy(49 * HOUR);
  assert.equal(telegram.length, 2);
});

test("sqlite outbox survives a restart and drains in order", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { UserDatabase } = require("../src/database");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "users.db");

  const first = makeBridge({ store: new UserDatabase(file), up: () => 500 });
  first.bridge.start();
  for (let n = 1; n <= 3; n++) first.bridge.enqueue({ event: message(n), origin: "user" });
  await first.bridge.settled();
  await first.time.advanceBy(0);
  await first.store.close();

  const second = makeBridge({ store: new UserDatabase(file) });
  second.time.current = first.time.now() + HOUR;
  second.bridge.start();
  await second.time.runAll();
  assert.deepEqual(second.remy.accepted.map((e) => e.id), ["mid.1", "mid.2", "mid.3"]);
  await second.store.close();
});
