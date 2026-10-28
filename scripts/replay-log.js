#!/usr/bin/env node
// Replays the production bot log through the new engine (decide() via the same
// Responder the server uses, with virtual time and fakes) and writes a report.
// Sends nothing: no Instagram, no Telegram, no network at all.
//
// Usage: node scripts/replay-log.js <bot.log> [--out REPLAY.md] [--users-db users.db]
//   --out       default: REPLAY.md in the parent folder of the log's folder
//   --users-db  default: users.db next to the log (read-only, only for names)

const fs = require("fs");
const path = require("path");
const { parseBotLog } = require("./lib/bot-log");
const { VirtualTime } = require("./lib/virtual-time");
const { Responder } = require("../src/responder");
const { MemoryStore } = require("../src/memory-store");
const { initLanguageDetector, detectLanguage } = require("../src/language");
const { SILENCE_REASONS } = require("../src/engine");
const { classifyMessage } = require("../src/detect");

const BOT_ID = "replay-bot";
const HOUR = 60 * 60 * 1000;

// The 7 people the old bot interrupted in the middle of a real conversation
const CONVERSATION_CASES = [
  { userId: "917715444572384", label: "Creadora UGC negociando tarifas, envía enlaces de TikTok (\"creo que tienen un mensaje predeterminado\")" },
  { userId: "1476742484049559", label: "Creadora UGC negociando tarifas, envía enlaces a sus vídeos" },
  { userId: "1859028438067278", label: "Clienta de pago (Toñi) haciendo preguntas" },
  { userId: "1792557081435479", label: "Usuaria guiada paso a paso (Joana, \"No se llegar\")" },
  { userId: "647389718174281", label: "Usuario guiado paso a paso (Miguel, \"Estos son los pasos\")" },
  { userId: "855896286891916", label: "Usuario que pregunta y recibe un vídeo de un humano (Fénix, \"Como guardo la receta\")" },
  { userId: "3140806602756539", label: "Amiga recomendando una cocinera (Ausen)" },
];

const OLD_REEL_REPLY_RE = /por aquí|Recuerda|Aviso|primera vez|otro reel/i;

function parseArgs(argv) {
  const args = { log: null, out: null, usersDb: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--users-db") args.usersDb = argv[++i];
    else if (!args.log) args.log = argv[i];
  }
  if (!args.log) {
    console.error("Usage: node scripts/replay-log.js <bot.log> [--out REPLAY.md] [--users-db users.db]");
    process.exit(1);
  }
  const logDir = path.dirname(path.resolve(args.log));
  args.out = args.out || path.join(path.dirname(logDir), "REPLAY.md");
  args.usersDb = args.usersDb || path.join(logDir, "users.db");
  return args;
}

async function loadNames(usersDbPath) {
  const names = new Map();
  if (!fs.existsSync(usersDbPath)) return names;
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database(usersDbPath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((resolve, reject) =>
    db.all("SELECT user_id, username, full_name FROM users", (err, result) => (err ? reject(err) : resolve(result)))
  );
  await new Promise((resolve) => db.close(resolve));
  for (const row of rows) names.set(row.user_id, { name: row.full_name || null, username: row.username || null });
  return names;
}

// Rebuilds the webhook message the old bot received, from what the log kept
function toWebhookMessage(entry) {
  if (entry.text === "[attachment]") {
    // The old bot answered shared reels/posts (reel branch); other attachments were photos, stickers...
    return entry.oldBranch === "reel"
      ? { attachments: [{ type: "ig_reel", payload: { url: "https://lookaside.replay/reel" } }] }
      : { attachments: [{ type: "image", payload: { url: "https://lookaside.replay/image" } }] };
  }
  return { text: entry.text };
}

const month = (ms) => new Date(ms).toISOString().slice(0, 7);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const short = (text, n = 50) => {
  const chars = Array.from(String(text).replace(/\s+/g, " "));
  return (chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("")).replace(/\|/g, "/");
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const events = parseBotLog(fs.readFileSync(args.log, "utf8"));
  const names = await loadNames(args.usersDb);
  await initLanguageDetector();

  const time = new VirtualTime(events[0].at);
  const store = new MemoryStore();
  const decisions = [];
  const sends = [];
  const notifications = [];
  let mid = 0;

  const responder = new Responder({
    store,
    profiles: {
      // Profile fields are not in the log: assume not followed, not verified, few followers
      get: async (userId) => ({
        status: "ok",
        profile: { ...(names.get(userId) || { name: null, username: null }), followerCount: null, isBusinessFollowUser: false, isVerifiedUser: false },
      }),
    },
    sender: {
      send: async (userId, message) => {
        sends.push({ userId, message, at: time.now() });
        return { recipient_id: userId, message_id: `replay.${++mid}` };
      },
    },
    notifier: {
      message: async (profile, text) => notifications.push({ type: "message", at: time.now() }),
      recipeNotAnswered: async () => notifications.push({ type: "suppressed", at: time.now() }),
      repeatedReels: async (profile, count) => notifications.push({ type: "escalation", at: time.now(), count }),
      needsHelp: async () => notifications.push({ type: "needs_help", at: time.now() }),
    },
    logger: { log() {}, error(message, error) { console.error(message, error); }, userMessage() {}, automaticMessage() {}, manualMessage() {} },
    clock: time,
    scheduler: time,
    detectLanguage,
    config: { replyMode: "live", botAccountId: BOT_ID, engine: { publicBaseUrl: "https://carlotes.ganxo.net" } },
    onDecision: (info) => decisions.push(info),
  });

  // Feed the log in time order
  const inbound = [];
  for (const entry of events) {
    await time.advanceTo(entry.at);
    if (entry.type === "user") {
      const message = toWebhookMessage(entry);
      inbound.push({ ...entry, message, isRecipe: classifyMessage(message).kind === "recipe" });
      await responder.handleWebhookEvent({ sender: { id: entry.userId }, recipient: { id: BOT_ID }, message: { mid: `in.${inbound.length}`, ...message } });
    } else if (entry.type === "manual") {
      // A human from our team (the old bot logged echoes it did not recognize as manual)
      await responder.handleWebhookEvent({ sender: { id: BOT_ID }, recipient: { id: entry.userId }, message: { mid: `human.${entry.at}`, text: entry.text, is_echo: true } });
    }
    // "automatic" lines are the old bot's own replies: the new engine does not see them
  }
  await time.runAll();

  // ---- Numbers ----
  const oldAuto = events.filter((e) => e.type === "automatic");
  const oldReelReplies = oldAuto.filter((e) => OLD_REEL_REPLY_RE.test(e.text));
  const recipeDecisions = decisions.filter((d) => d.event.type === "recipe");
  const replies = decisions.filter((d) => d.action.type === "reply");
  const recipeReplies = replies.filter((d) => d.event.type === "recipe");

  // Map every inbound reel/link to the decision of its debounce group
  const reelDecision = new Map();
  for (const d of recipeDecisions) {
    for (const e of inbound) {
      if (e.isRecipe && e.userId === d.userId && e.at >= d.event.at && e.at <= d.event.lastAt && !reelDecision.has(e)) {
        reelDecision.set(e, { decision: d, first: e.at === d.event.at });
      }
    }
  }
  const recipeInbound = inbound.filter((e) => reelDecision.has(e));
  const oldRepliedInbound = inbound.filter((e) => e.oldBranch === "reel");
  const newlyDetected = recipeInbound.filter((e) => e.oldBranch !== "reel");

  const byMonth = new Map();
  for (const e of oldAuto) {
    const m = byMonth.get(month(e.at)) || { oldAuto: 0, newReplies: 0, newMessages: 0 };
    m.oldAuto += 1;
    byMonth.set(month(e.at), m);
  }
  for (const d of recipeReplies) {
    const m = byMonth.get(month(d.at)) || { oldAuto: 0, newReplies: 0, newMessages: 0 };
    m.newReplies += 1;
    m.newMessages += d.action.messages.length;
    byMonth.set(month(d.at), m);
  }

  const reasonGroups = new Map();
  const reasonReels = new Map();
  for (const d of recipeDecisions) {
    const key = d.action.type === "reply" ? `reply:${d.action.kind}` : d.action.reason;
    inc(reasonGroups, key);
  }
  for (const e of recipeInbound) {
    const { decision, first } = reelDecision.get(e);
    const key = !first ? "debounce" : decision.action.type === "reply" ? `reply:${decision.action.kind}` : decision.action.reason;
    inc(reasonReels, key);
  }
  const notRecipeOldReplied = oldRepliedInbound.filter((e) => !reelDecision.has(e));

  const oldPerUser = new Map();
  for (const e of oldAuto) inc(oldPerUser, e.userId);
  const heaviest = [...oldPerUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  const nameOf = (userId) => {
    const n = names.get(userId);
    if (!n) return userId;
    return [n.name, n.username ? `@${n.username}` : null].filter(Boolean).join(" ") || userId;
  };

  const notifyCounts = new Map();
  for (const n of notifications) inc(notifyCounts, n.type);

  // ---- Report ----
  const lines = [];
  const p = (line = "") => lines.push(line);
  const first = events[0].at;
  const last = events[events.length - 1].at;

  p("# Replay del log de producción con el motor nuevo");
  p();
  p(`Generado por \`node scripts/replay-log.js\` el ${new Date().toISOString().slice(0, 10)}. Log: ${when(first)} a ${when(last)} (UTC), ${events.length} mensajes.`);
  p("No envía nada: Instagram y Telegram son falsos. Supuestos: los campos de perfil no están en el log, así que todos cuentan como no seguidos, no verificados y con pocos seguidores; un `[attachment]` que el bot viejo contestó es un reel compartido, el resto son fotos o stickers; el texto del log está cortado a 60 caracteres.");
  p();
  p("## Resumen");
  p();
  p("| | Bot viejo | Motor nuevo |");
  p("|---|---:|---:|");
  p(`| Mensajes automáticos | ${oldAuto.length} (${oldReelReplies.length} por reels/enlaces, ${oldAuto.length - oldReelReplies.length} ACK) | ${recipeReplies.reduce((s, d) => s + d.action.messages.length, 0)} mensajes de Instagram en ${recipeReplies.length} respuestas |`);
  p(`| Respuestas de nivel 1 (vídeo + texto + botones) | | ${recipeReplies.filter((d) => d.action.kind === "level1").length} |`);
  p(`| Respuestas de nivel 2 (una línea) | | ${recipeReplies.filter((d) => d.action.kind === "level2").length} |`);
  p(`| Personas que reciben algo | ${oldPerUser.size} | ${new Set(recipeReplies.map((d) => d.userId)).size} |`);
  p(`| Reels/enlaces que el bot viejo intentaba contestar | ${oldRepliedInbound.length} | ${recipeInbound.length} cuentan como receta (${newlyDetected.length} de ellos el bot viejo no los detectaba), ${notRecipeOldReplied.length} ya no |`);
  p(`| Avisos de Telegram nuevos | | ${notifyCounts.get("suppressed") || 0} reels no contestados por una regla de conversación o creador, ${notifyCounts.get("escalation") || 0} "escríbele tú" (nivel 3) |`);
  p();
  p("Un mensaje de nivel 1 son 2 mensajes de Instagram (el vídeo y el texto con los botones).");
  p();
  p("## Por mes");
  p();
  p("| Mes | Bot viejo (automáticos) | Motor nuevo (respuestas) | Motor nuevo (mensajes) |");
  p("|---|---:|---:|---:|");
  for (const [m, v] of [...byMonth.entries()].sort()) p(`| ${m} | ${v.oldAuto} | ${v.newReplies} | ${v.newMessages} |`);
  p();
  p("## Qué pasa con cada reel");
  p();
  p(`${recipeInbound.length} reels/enlaces de receta, agrupados en ${recipeDecisions.length} decisiones (la espera de 60 s junta los que llegan seguidos).`);
  p();
  p("| Regla | Decisiones | Reels cubiertos |");
  p("|---|---:|---:|");
  const reasonLabel = (key) => {
    if (key === "reply:level1") return "Respuesta nivel 1";
    if (key === "reply:level2") return "Respuesta nivel 2";
    if (key === "debounce") return "Misma espera de 60 s que el reel anterior";
    return `Silencio: ${SILENCE_REASONS[key] ? SILENCE_REASONS[key].label : key} (\`${key}\`)`;
  };
  const keys = ["reply:level1", "reply:level2", "debounce", ...Object.keys(SILENCE_REASONS)];
  for (const key of keys) {
    if (!reasonGroups.get(key) && !reasonReels.get(key)) continue;
    p(`| ${reasonLabel(key)} | ${reasonGroups.get(key) || 0} | ${reasonReels.get(key) || 0} |`);
  }
  p(`| Ya no cuenta como receta (otros enlaces, perfiles de TikTok, textos largos con enlace) | | ${notRecipeOldReplied.length} |`);
  p();
  p("Las reglas se aplican en este orden: ráfaga, humano en 14 días, texto pendiente 24 h, creador/perfil, respuesta reciente (1 h), nivel.");
  p();
  p("## Las 4 personas que más mensajes recibían");
  p();
  p("| Persona | Bot viejo | Motor nuevo | Avisos \"escríbele tú\" |");
  p("|---|---:|---:|---:|");
  for (const [userId, count] of heaviest) {
    const mine = recipeReplies.filter((d) => d.userId === userId);
    const kinds = mine.map((d) => d.action.kind).join(", ");
    const escalations = decisions.filter((d) => d.userId === userId && d.action.notify && d.action.notify.type === "escalation").length;
    p(`| ${nameOf(userId)} (${userId}) | ${count} | ${mine.length} (${kinds || "ninguna"}) | ${escalations} |`);
  }
  p();
  p("## Los 7 casos de conversación");
  p();
  p("Para cada persona: los reels/enlaces, los mensajes de la hora de alrededor (H = humano del equipo), lo que hizo el bot viejo y lo que hace el motor nuevo. Estos 7 casos salen del log: personas a las que el bot viejo contestó un reel con una conversación humana en marcha.");
  for (const { userId, label } of CONVERSATION_CASES) {
    p();
    p(`### ${label}`);
    p();
    p(`${nameOf(userId)} (${userId})`);
    p();
    p("| Hora (UTC) | Mensaje | Bot viejo | Motor nuevo |");
    p("|---|---|---|---|");
    const timeline = events.filter((e) => e.userId === userId);
    const inboundOfUser = inbound.filter((e) => e.userId === userId);
    const isReelRow = (e) => e.type === "user" && (e.oldBranch === "reel" || (inboundOfUser.find((x) => x.at === e.at && x.text === e.text) || {}).isRecipe);
    const reelTimes = timeline.filter(isReelRow).map((e) => e.at);
    const nearReel = (e) => reelTimes.some((t) => Math.abs(t - e.at) <= HOUR);
    const outcomeOf = (e) => {
      const entry = inboundOfUser.find((x) => x.at === e.at && x.text === e.text);
      if (entry && reelDecision.has(entry)) {
        const { decision, first: isFirst } = reelDecision.get(entry);
        if (!isFirst) return "silencio (misma espera de 60 s)";
        if (decision.action.type === "reply") return `**envía ${decision.action.kind}**`;
        return `silencio: ${SILENCE_REASONS[decision.action.reason].label}`;
      }
      return e.oldBranch === "reel" ? "no es receta: sin respuesta" : "";
    };
    let reelRows = 0;
    const rest = new Map();
    for (const e of timeline) {
      if (e.type === "automatic") continue;
      const reelRow = isReelRow(e);
      if (!reelRow && !nearReel(e)) continue;
      if (reelRow && reelRows >= 25) {
        inc(rest, outcomeOf(e).replace(/\*\*/g, ""));
        continue;
      }
      if (!reelRow && reelRows >= 25) continue;
      if (e.type === "manual") {
        p(`| ${when(e.at)} | H: ${short(e.text || "[vídeo/foto]")} | | |`);
        continue;
      }
      // The old bot's echo comes right after the reel it answered
      const following = timeline[timeline.indexOf(e) + 1];
      const oldReplied = e.oldBranch === "reel" && following && following.type === "automatic" && OLD_REEL_REPLY_RE.test(following.text);
      p(`| ${when(e.at)} | ${short(e.text)} | ${oldReplied ? "aviso automático" : ""} | ${reelRow ? outcomeOf(e) : ""} |`);
      if (reelRow) reelRows += 1;
    }
    if (rest.size > 0) {
      const summary = [...rest.entries()].map(([k, v]) => `${v} × ${k}`).join("; ");
      p(`| … | ${[...rest.values()].reduce((a, b) => a + b, 0)} reels más | | ${summary} |`);
    }
    const oldCount = oldAuto.filter((e) => e.userId === userId && OLD_REEL_REPLY_RE.test(e.text)).length;
    const newCount = recipeReplies.filter((d) => d.userId === userId).length;
    p();
    p(`Total: bot viejo ${oldCount} avisos, motor nuevo ${newCount} respuestas.`);
  }
  p();

  fs.writeFileSync(args.out, lines.join("\n"));
  console.log(`Old automatic messages: ${oldAuto.length} (${oldReelReplies.length} reel/link replies)`);
  console.log(`New: ${recipeReplies.length} replies = ${recipeReplies.reduce((s, d) => s + d.action.messages.length, 0)} Instagram messages`);
  console.log(`Recipe decisions by rule: ${JSON.stringify(Object.fromEntries(reasonGroups))}`);
  console.log(`Reels by rule: ${JSON.stringify(Object.fromEntries(reasonReels))}, no longer recipes: ${notRecipeOldReplied.length}`);
  console.log(`Sends to the fake sender: ${sends.length}; Telegram (fake): ${JSON.stringify(Object.fromEntries(notifyCounts))}`);
  console.log(`Report written to ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
