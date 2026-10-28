// Cases built from the real production log (29-sep-2025 to 28-oct-2026)
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHarness } = require("./helpers");
const { MINUTE, HOUR, DAY } = require("../src/engine");

const reasons = (h, userId) => h.decisions.filter((d) => d.userId === userId).map((d) => d.action.reason || d.action.kind);

test("13 reels in 20 minutes (Nati, 2025-11-08) get one reply", async () => {
  const h = await makeHarness();
  const user = "2053012782302855";
  const gapsSeconds = [15, 27, 44, 59, 103, 57, 49, 48, 173, 346, 99, 85];
  await h.reel(user);
  for (const gap of gapsSeconds) {
    await h.wait(gap * 1000);
    await h.reel(user);
  }
  await h.wait(2 * MINUTE);
  await h.time.runAll();

  assert.equal(h.repliesTo(user).length, 1);
  assert.equal(h.repliesTo(user)[0].action.kind, "level1");
  // Level 1 = tutorial video + text with quick replies
  assert.deepEqual(h.sentTo(user).map((s) => (s.message.video ? "video" : "text")), ["video", "text"]);
  assert.equal(h.sentTo(user)[0].message.video, "https://example.test/media/tutorial-instagram-es.mp4");
  assert.ok(reasons(h, user).every((r) => ["level1", "burst", "cooldown"].includes(r)), reasons(h, user).join(","));
});

test("creator negotiating rates who sends TikTok links after our human messages (mar, 2026-03-21): silence", async () => {
  const h = await makeHarness();
  const user = "917715444572384";
  await h.text(user, "Holaaa!! que tal? primeramente disculpa el atrevimiento de escribirte");
  await h.wait(7 * HOUR);
  await h.echo(user, "mid.human.1", "Hola Mariana, soy Carles, que tal?");
  await h.echo(user, "mid.human.2", "Me podrías compartir tus tarifas para poder valorarlo?");
  await h.wait(53 * MINUTE);
  await h.text(user, "te paso unas de mis cuentas tal vez en tiktok");
  await h.link(user, "https://www.tiktok.com/@marlovesphotography?_r=1&_t=ZS-94sBC");
  await h.link(user, "https://vm.tiktok.com/ZMh7abc12/");
  await h.wait(2 * MINUTE);
  // Next day, another TikTok video link
  await h.wait(DAY);
  await h.link(user, "https://www.tiktok.com/@marianacookinglife/video/7312345678901234567");
  await h.time.runAll();

  assert.equal(h.sent.length, 0);
  assert.deepEqual(
    h.decisions.filter((d) => d.event.type === "recipe").map((d) => d.action.reason),
    ["human_recent", "human_recent"]
  );
  // Telegram still hears about it, as today
  assert.ok(h.notifications.some((n) => n.type === "suppressed"));
});

test("a person we follow: silence + Telegram", async () => {
  const h = await makeHarness({ profiles: { u1: { isBusinessFollowUser: true } } });
  await h.reel("u1");
  await h.time.runAll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.decisions[0].action.reason, "creator_followed");
  assert.equal(h.notifications[0].type, "suppressed");
});

test("a verified account: silence", async () => {
  const h = await makeHarness({ profiles: { u1: { isVerifiedUser: true } } });
  await h.reel("u1");
  await h.time.runAll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.decisions[0].action.reason, "creator_verified");
});

test("followers >= CREATOR_FOLLOWER_THRESHOLD: silence; below: normal flow", async () => {
  const h = await makeHarness({ profiles: { big: { followerCount: 5000 }, small: { followerCount: 4999 } } });
  await h.reel("big");
  await h.reel("small");
  await h.time.runAll();
  assert.equal(h.decisions.find((d) => d.userId === "big").action.reason, "creator_followers");
  assert.equal(h.decisions.find((d) => d.userId === "small").action.kind, "level1");
});

test("profile API failure: silent for links, normal flow for native reel shares", async () => {
  const h = await makeHarness({ failingProfiles: ["a", "b"] });
  await h.link("a", "https://www.instagram.com/reel/ABC123/");
  await h.reel("b");
  await h.time.runAll();
  assert.equal(h.decisions.find((d) => d.userId === "a").action.reason, "profile_unknown");
  assert.equal(h.decisions.find((d) => d.userId === "b").action.kind, "level1");
});

test("free text pending a human answer (Toñi asking, Joana 'No se llegar'): silence for 24 h", async () => {
  const h = await makeHarness();
  const user = "1792557081435479";
  await h.text(user, "No se llegar");
  await h.wait(4 * MINUTE);
  await h.reel(user);
  await h.time.runAll();
  assert.equal(h.decisions.at(-1).action.reason, "pending_human");
  assert.equal(h.sent.length, 0);

  // 25 hours later with nobody answering, the bot may help again
  await h.wait(25 * HOUR);
  await h.reel(user);
  await h.time.runAll();
  assert.equal(h.decisions.at(-1).action.kind, "level1");
});

test("free text right after a reel, inside the debounce wait (text that comes with the reel): silence", async () => {
  const h = await makeHarness();
  const user = "3140806602756539";
  await h.reel(user);
  await h.wait(2 * 1000);
  await h.text(user, "He passat aquesta per si teniu controlada aquesta cuinera. Molt bona!");
  await h.time.runAll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.decisions.find((d) => d.event.type === "recipe").action.reason, "pending_human");
});

test("human answered the free text: the 14-day human rule takes over", async () => {
  const h = await makeHarness();
  await h.text("u", "Como guardo la receta");
  await h.echo("u", "mid.human.9", "Buenas Fénix, te mando un video de cómo guardarlas");
  await h.wait(13 * DAY);
  await h.reel("u");
  await h.time.runAll();
  assert.equal(h.decisions.at(-1).action.reason, "human_recent");
  await h.wait(2 * DAY);
  await h.reel("u");
  await h.time.runAll();
  assert.equal(h.decisions.at(-1).action.kind, "level1");
});

test("escalation level 1 -> 2 -> 3 (silence, Telegram once per week)", async () => {
  const h = await makeHarness({ profiles: { u: { name: "Nati Ranz Perez", username: "marynaty6" } } });
  await h.reel("u");
  await h.time.runAll();
  await h.wait(2 * DAY);
  await h.reel("u");
  await h.time.runAll();
  await h.wait(DAY);
  await h.reel("u");
  await h.time.runAll();
  await h.wait(3 * HOUR);
  await h.reel("u");
  await h.time.runAll();
  await h.wait(DAY);
  await h.reel("u");
  await h.time.runAll();
  await h.wait(6 * DAY);
  await h.reel("u");
  await h.time.runAll();

  assert.deepEqual(reasons(h, "u"), ["level1", "level2", "level3", "level3", "level3", "level3"]);
  assert.equal(h.sent.length, 3); // video + text, then one line
  assert.match(h.sent[1].message.text, /^¡Hola, Nati!/);
  assert.equal(h.sent[1].message.quickReplies.length, 3);
  const escalations = h.notifications.filter((n) => n.type === "escalation");
  assert.equal(escalations.length, 2);
  assert.equal(escalations[0].count, 3);
  assert.equal(escalations[0].profile.username, "marynaty6");
});

test("after 30 days without reels the next one starts at level 2, with a different wording", async () => {
  const h = await makeHarness();
  await h.reel("u");
  await h.time.runAll();
  await h.wait(2 * DAY);
  await h.reel("u");
  await h.time.runAll();
  await h.wait(DAY);
  await h.reel("u"); // level 3
  await h.time.runAll();
  await h.wait(31 * DAY);
  await h.reel("u");
  await h.time.runAll();

  assert.deepEqual(reasons(h, "u"), ["level1", "level2", "level3", "level2"]);
  const level2 = h.repliesTo("u").filter((d) => d.action.kind === "level2");
  assert.notEqual(level2[0].action.variant, level2[1].action.variant);
  assert.notEqual(level2[0].action.messages[0].text, level2[1].action.messages[0].text);
  // No video the second time
  assert.ok(level2[1].action.messages.every((m) => !m.video));
});

test("quick reply 'Ya me sale': one short happy line", async () => {
  const h = await makeHarness();
  await h.quickReply("u", "WORKS|es", "Ya me sale ✅");
  assert.equal(h.sent.length, 1);
  assert.equal(h.decisions[0].action.kind, "WORKS");
  assert.equal(h.notifications.length, 0);
});

test("quick reply 'No me sale CookNest': explains + tutorial link + Telegram follow-up, in the payload language", async () => {
  const h = await makeHarness();
  await h.quickReply("u", "NO_ICON|ca", "No em surt CookNest");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.text, /https:\/\/cooknest\.app\/tutorial/);
  assert.match(h.sent[0].message.text, /Més/);
  assert.deepEqual(h.notifications.map((n) => n.type), ["needs_help"]);
});

test("quick reply 'No tengo la app': what CookNest does + link", async () => {
  const h = await makeHarness();
  await h.quickReply("u", "NO_APP|en", "I don't have the app");
  assert.match(h.sent[0].message.text, /https:\/\/cooknest\.app$/);
  assert.match(h.sent[0].message.text, /CookNest/);
});

test("a quick reply is not free text: a reel after it is not blocked by the 24 h rule", async () => {
  const h = await makeHarness();
  await h.reel("u");
  await h.time.runAll();
  await h.quickReply("u", "NO_ICON|es");
  await h.wait(2 * HOUR);
  await h.reel("u");
  await h.time.runAll();
  assert.deepEqual(reasons(h, "u").filter((r) => r !== "NO_ICON"), ["level1", "level2"]);
});

test("replies in the language of the person's own text", async () => {
  const h = await makeHarness({ profiles: { u: { name: "Ausen Perez" } } });
  await h.text("u", "Bon dia, com puc guardar les receptes que veig a Instagram?");
  await h.wait(25 * HOUR);
  await h.reel("u");
  await h.time.runAll();
  const text = h.sent.find((s) => s.message.text).message;
  assert.match(text.text, /^Hola, Ausen!/);
  assert.deepEqual(text.quickReplies.map((q) => q.title), ["Ja em surt ✅", "No em surt CookNest", "No tinc l'app"]);
  assert.deepEqual(text.quickReplies.map((q) => q.payload), ["WORKS|ca", "NO_ICON|ca", "NO_APP|ca"]);
});

test("Spanish by default when the person never wrote text", async () => {
  const h = await makeHarness();
  await h.reel("u");
  await h.time.runAll();
  assert.equal(h.decisions[0].action.lang, "es");
});

test("echo mids: our own messages are not a human, any other echo is", async () => {
  const h = await makeHarness();
  await h.reel("u");
  await h.time.runAll();
  for (const s of h.sentTo("u")) await h.echo("u", s.mid, s.message.text || "");
  assert.equal((await h.store.getState("u", "live", h.time.now())).lastHumanAt, null);

  await h.echo("u", "mid.typed.by.carles", "Hola! te ayudo?");
  assert.equal((await h.store.getState("u", "live", h.time.now())).lastHumanAt, h.time.now());
});

test("echo arriving before the send API returns its mid is still recognized as ours", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await makeHarness({ sendDelay: () => gate });
  const replyDone = h.quickReply("u", "WORKS|es"); // the send waits on the gate
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.responder.inflight.has("u"), "send should be in flight");
  const echoDone = h.echo("u", "mid.bot.1", "¡Genial!");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([replyDone, echoDone]);
  assert.equal((await h.store.getState("u", "live", h.time.now())).lastHumanAt, null);
});

test("shadow mode: decides and logs for everyone, sends only to TEST_USER_IDS", async () => {
  const h = await makeHarness({ replyMode: "shadow", testUserIds: ["tester"] });
  await h.reel("someone");
  await h.reel("tester");
  await h.time.runAll();
  assert.ok(h.logger.lines.includes("[shadow] would send level1 to someone"));
  assert.equal(h.sentTo("someone").length, 0);
  assert.equal(h.sentTo("tester").length, 2);
  // Shadow decisions are kept apart from the real reply history
  assert.equal((await h.store.getState("someone", "live", h.time.now())).level1SentAt, null);
  assert.ok((await h.store.getState("someone", "shadow", h.time.now())).level1SentAt);
});

test("other messages are never answered and still reach Telegram", async () => {
  const h = await makeHarness();
  await h.text("u", "Hola, tengo una duda con la suscripción");
  await h.link("u", "https://ln.run/insignia-personal-verificada2026");
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.notifications.map((n) => n.type), ["message", "message"]);
});
