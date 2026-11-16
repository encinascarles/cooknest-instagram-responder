// The replay proof on a small synthetic log: forwarding to Remy on or off, the
// bot decides exactly the same.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBotLog } = require("../scripts/lib/bot-log");
const { replayEvents, decisionLine } = require("../scripts/replay-log");

// Same format as logs/bot.log (made-up ids and texts)
const LOG = `[2026-03-01 10:00:00.000] CookNest IG Responder listening on port 3000
[2026-03-01 10:00:05.000] User 1001 sent message "[attachment]"
[2026-03-01 10:00:06.000] Automatic message sent by us to 1001: "¡Hola! Esta receta ha llegado a nuestro chat"
[2026-03-01 10:00:40.000] User 1001 sent message "[attachment]"
[2026-03-01 10:01:10.000] User 1001 sent message "https://www.instagram.com/reel/ABCDEF123/"
[2026-03-01 11:00:00.000] User 2002 sent message "Hola! tengo una duda con la suscripción"
[2026-03-01 11:00:00.100] ACK disabled in config
[2026-03-01 11:02:00.000] User 2002 sent message "[attachment]"
[2026-03-01 12:00:00.000] Manual message sent by us to 2002: "Hola! te ayudo, dime"
[2026-03-01 12:30:00.000] User 2002 sent message "[attachment]"
[2026-03-01 13:00:00.000] User 3003 sent message "[attachment]"
[2026-03-01 13:00:00.100] ACK Debug - User: 3003, shouldSendAck: false, windowDays: 7
[2026-03-03 09:00:00.000] User 1001 sent message "[attachment]"
[2026-03-04 09:00:00.000] User 1001 sent message "[attachment]"
[2026-03-04 09:00:30.000] User 1001 sent message "Gracias! ya me sale"
[2026-03-04 09:00:30.100] ACK disabled in config
`;

test("replay: identical decisions with forwarding on and off; Remy gets every event, signed", async () => {
  const events = parseBotLog(LOG);
  const off = await replayEvents(events);
  const on = await replayEvents(events, { forward: true });

  assert.deepEqual(on.decisions.map(decisionLine), off.decisions.map(decisionLine));
  assert.deepEqual(on.sends, off.sends);
  assert.deepEqual(on.notifications, off.notifications);
  assert.equal(off.remy, null);

  const reasons = off.decisions.map((d) => `${d.userId}:${d.action.kind || d.action.reason}`);
  assert.deepEqual(reasons, [
    "1001:level1",
    "1001:burst",
    "1001:burst",
    "2002:free_text",
    "2002:pending_human",
    "2002:human_recent",
    "3003:not_recipe",
    "1001:level2",
    "1001:level3",
    "1001:free_text",
  ]);

  // 10 inbound messages + 1 human echo, each once, in a signed POST
  const { remy } = on;
  assert.equal(remy.unsigned, 0);
  assert.equal(on.outboxLeft, 0);
  assert.equal(remy.events.length, 11);
  assert.equal(new Set(remy.events.map((e) => e.id)).size, 11);
  const inbound = remy.events.filter((e) => e.origin === "user");
  assert.deepEqual(
    inbound.map((e) => `${e.event.sender.id}:${e.bot.classified}/${e.bot.decision}/${e.bot.kind || e.bot.reason}`),
    off.decisions.map((d) => `${d.userId}:${d.event.type}/${d.action.type === "reply" ? "reply" : "silent"}/${d.action.kind || d.action.reason}`)
  );
  assert.deepEqual(remy.events.filter((e) => e.origin !== "user").map((e) => [e.origin, e.event.message.text]), [["human", "Hola! te ayudo, dime"]]);
});
