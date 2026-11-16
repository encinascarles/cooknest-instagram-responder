// The responder hands every webhook event to Remy, with the bot's decision, and
// keeps answering exactly as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHarness, BOT_ID } = require("./helpers");
const { MINUTE, DAY } = require("../src/engine");

const byId = (events) => Object.fromEntries(events.map((e) => [e.id, e]));

test("a text is forwarded after the decision: origin user, bot filled, profile in Remy's shape", async () => {
  const h = await makeHarness({ bridge: true, profiles: { u1: { name: "Ana Pi", username: "anapi", profilePic: "https://cdn.test/a.jpg" } } });
  await h.text("u1", "Hola, una pregunta sobre la suscripción");
  const [forwarded] = await h.forwarded();
  assert.equal(forwarded.id, "mid.user.1");
  assert.equal(forwarded.origin, "user");
  assert.deepEqual(forwarded.event.message, { mid: "mid.user.1", text: "Hola, una pregunta sobre la suscripción" });
  assert.deepEqual(forwarded.bot, { classified: "text", decision: "silent", kind: null, reason: "free_text" });
  assert.deepEqual(forwarded.profile, {
    igsid: "u1",
    username: "anapi",
    name: "Ana Pi",
    followerCount: 100,
    isVerifiedUser: null,
    isUserFollowBusiness: null,
    isBusinessFollowUser: null,
    profilePic: "https://cdn.test/a.jpg",
  });
  assert.deepEqual(h.decisions[0].bot, forwarded.bot, "onDecision sees what Remy gets");
});

test("a reel answered at level 1, its echoes (bot), a human echo, a quick reply", async () => {
  const h = await makeHarness({ bridge: true });
  await h.reel("u1");
  await h.time.runAll();
  for (const s of h.sentTo("u1")) await h.echo("u1", s.mid, s.message.text || "");
  await h.wait(MINUTE);
  await h.echo("u1", "mid.typed.on.phone", "Hola! soy Carles");
  await h.quickReply("u1", "WORKS|es", "Ya me sale ✅");

  const events = await h.forwarded();
  const got = events.map((e) => [e.id, e.origin, e.bot && `${e.bot.classified}/${e.bot.decision}/${e.bot.kind || e.bot.reason}`]);
  assert.deepEqual(got, [
    ["mid.user.1", "user", "recipe/reply/level1"],
    ["mid.bot.1", "bot", null],
    ["mid.bot.2", "bot", null],
    ["mid.typed.on.phone", "human", null],
    ["mid.user.2", "user", "quick_reply/silent/human_recent"],
  ]);
  // The quick reply came after a human message: the bot stays out, as before
  assert.equal(h.sent.length, 2);
  // Echoes carry the cached profile, or null when there is none (never a half-built object)
  assert.deepEqual(events.slice(1, 4).map((e) => e.profile), [null, null, null]);
  await h.store.saveProfile("u1", { name: "Ana", username: "ana" }, h.time.now());
  await h.echo("u1", "mid.typed.again", "¿Te sale?");
  const last = (await h.forwarded()).at(-1);
  assert.deepEqual([last.id, last.profile.igsid, last.profile.username], ["mid.typed.again", "u1", "ana"]);
});

test("reel burst: every reel carries its decision; grouped reels share the group's one decision", async () => {
  // Default (no wait): the first reel is answered, the next ones fall in the burst rule
  const h = await makeHarness({ bridge: true });
  await h.reel("u1");
  await h.wait(30 * 1000);
  await h.reel("u1");
  await h.wait(40 * 1000);
  await h.reel("u1");
  await h.time.runAll();
  assert.deepEqual(
    (await h.forwarded()).map((e) => [e.id, e.bot.decision, e.bot.kind || e.bot.reason]),
    [["mid.user.1", "reply", "level1"], ["mid.user.2", "silent", "burst"], ["mid.user.3", "silent", "burst"]]
  );

  // With a wait, the reels of one group are decided once and each carries it
  const g = await makeHarness({ bridge: true, debounceMs: 60 * 1000 });
  await g.reel("u2");
  await g.wait(10 * 1000);
  await g.reel("u2");
  await g.wait(10 * 1000);
  await g.reel("u2");
  await g.time.runAll();
  assert.equal(g.decisions.length, 1);
  assert.equal(g.decisions[0].inbound.length, 3);
  const grouped = await g.forwarded();
  assert.deepEqual(grouped.map((e) => e.id), ["mid.user.1", "mid.user.2", "mid.user.3"]);
  for (const e of grouped) assert.deepEqual(e.bot, { classified: "recipe", decision: "reply", kind: "level1", reason: null });
});

test("the bot's handling throws: decision error, for a text and for every reel of a group", async () => {
  const h = await makeHarness({ bridge: true, debounceMs: 60 * 1000 });
  const getState = h.store.getState.bind(h.store);
  h.store.getState = async () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  await h.text("u1", "Hola");
  await h.reel("u2");
  await h.reel("u2");
  await h.time.runAll();
  h.store.getState = getState;

  const events = await h.forwarded();
  assert.deepEqual(events.map((e) => [e.id, e.bot.classified, e.bot.decision, e.bot.reason]), [
    ["mid.user.1", "text", "error", "SQLITE_BUSY: database is locked"],
    ["mid.user.2", "recipe", "error", "SQLITE_BUSY: database is locked"],
    ["mid.user.3", "recipe", "error", "SQLITE_BUSY: database is locked"],
  ]);
  assert.equal(h.logger.lines.filter((l) => l.startsWith("ERROR: Error processing event")).length, 2, "logged as before");
});

test("a profile that cannot be fetched is forwarded as null", async () => {
  const h = await makeHarness({ bridge: true, failingProfiles: ["u1"] });
  await h.reel("u1");
  await h.time.runAll();
  const [event] = await h.forwarded();
  assert.equal(event.profile, null);
  assert.equal(event.bot.decision, "reply");
});

test("Remy echo arriving before Graph answers the send is labelled remy, never human", async () => {
  const h = await makeHarness({ bridge: true });
  let release;
  const graphAnswered = new Promise((resolve) => (release = resolve));
  // What /internal/remy/send does: register the send, record the mid when Graph answers
  const send = (async () => {
    await graphAnswered;
    await h.store.recordRemyMessage("mid.remy.1", "u1", h.time.now());
  })();
  h.responder.trackInflight("u1", send);

  const echoDone = h.echo("u1", "mid.remy.1", "Hola desde Remy");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await echoDone;

  const [event] = await h.forwarded();
  assert.equal(event.origin, "remy");
  assert.equal((await h.store.getState("u1", "live", h.time.now())).lastHumanAt, h.time.now(), "a human holds the conversation");
});

test("reads, reactions, edits, unsends, unsupported and unknown events: forwarded, the bot does nothing", async () => {
  const h = await makeHarness({ bridge: true });
  await h.reel("u1");
  await h.time.runAll();
  const botMid = h.sentTo("u1")[1].mid;
  await h.store.saveProfile("u1", { name: "Ana", username: "ana" }, h.time.now());
  const before = { decisions: h.decisions.length, sent: h.sent.length, notifications: h.notifications.length };
  const fromUser = { sender: { id: "u1" }, recipient: { id: BOT_ID } };
  const fromUs = { sender: { id: BOT_ID }, recipient: { id: "u1" } };

  await h.raw({ ...fromUser, timestamp: 1, read: { mid: botMid } });
  await h.raw({ ...fromUser, timestamp: 2, reaction: { mid: botMid, action: "react", reaction: "love", emoji: "❤️" } });
  await h.raw({ ...fromUser, timestamp: 3, message_edit: { mid: "mid.user.1", text: "editado", num_edit: 1 } });
  await h.raw({ ...fromUser, timestamp: 4, message: { mid: "mid.user.9", is_deleted: true } });
  await h.raw({ ...fromUser, timestamp: 5, message: { mid: "mid.user.10", is_unsupported: true } });
  await h.raw({ ...fromUs, timestamp: 6, message: { mid: botMid, is_echo: true, is_deleted: true } });
  await h.raw({ ...fromUs, timestamp: 7, message: { mid: "mid.phone", is_echo: true, is_unsupported: true } });
  await h.raw({ ...fromUs, timestamp: 8, reaction: { mid: "mid.user.1", action: "react", reaction: "love" } });
  await h.raw({ ...fromUser, timestamp: 9, postback: { title: "Empezar", payload: "GET_STARTED" } });

  assert.deepEqual({ decisions: h.decisions.length, sent: h.sent.length, notifications: h.notifications.length }, before);
  const events = (await h.forwarded()).slice(1);
  assert.deepEqual(
    events.map((e) => [e.id.replace(/:[0-9a-f]{40}$/, ":<sha1>"), e.origin, e.bot]),
    [
      [`read:${botMid}:1`, "user", null],
      [`reaction:${botMid}:react:2`, "user", null],
      ["edit:mid.user.1:3", "user", null],
      ["deleted:mid.user.9", "user", null],
      ["mid.user.10", "user", null],
      [`deleted:${botMid}`, "bot", null],
      ["mid.phone", "human", null],
      ["reaction:mid.user.1:react:8", "human", null],
      ["postback:<sha1>", "user", null],
    ]
  );
  // The cached profile travels with them when the bot has one
  assert.deepEqual([events[0].profile.igsid, events[0].profile.username], ["u1", "ana"]);
  assert.equal(events.at(-1).profile.igsid, "u1");
});

test("forwarding on or off: the same decisions, sends and Telegram lines", async () => {
  const scenario = async (bridge) => {
    const h = await makeHarness({ bridge, profiles: { u: { name: "Nati Ranz", username: "marynaty6" } } });
    await h.reel("u");
    await h.time.runAll();
    await h.wait(2 * DAY);
    await h.reel("u");
    await h.time.runAll();
    await h.text("v", "Hola, tengo una duda");
    await h.wait(5 * MINUTE);
    await h.reel("v");
    await h.time.runAll();
    await h.echo("v", "mid.human", "Hola!");
    await h.wait(DAY);
    await h.reel("u");
    await h.time.runAll();
    await h.quickReply("u", "NO_ICON|es");
    return {
      decisions: h.decisions.map(({ bot, inbound, ...rest }) => rest),
      sent: h.sent,
      notifications: h.notifications,
      forwarded: bridge ? (await h.forwarded()).length : 0,
    };
  };
  const off = await scenario(false);
  const on = await scenario(true);
  assert.deepEqual(on.decisions, off.decisions);
  assert.deepEqual(on.sent, off.sent);
  assert.deepEqual(on.notifications, off.notifications);
  assert.equal(on.forwarded, 7);
});

test("a forward function that throws or never settles cannot stop the bot", async () => {
  const throwing = await makeHarness({
    forward: () => {
      throw new Error("boom");
    },
  });
  await throwing.reel("u1");
  await throwing.time.runAll();
  assert.equal(throwing.sent.length, 2);

  const hanging = await makeHarness({ forward: () => new Promise(() => {}) });
  await hanging.quickReply("u1", "WORKS|es");
  await hanging.echo("u1", "mid.bot.1");
  assert.equal(hanging.sent.length, 1);
});
