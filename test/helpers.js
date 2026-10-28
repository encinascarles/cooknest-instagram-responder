const { Responder } = require("../src/responder");
const { MemoryStore } = require("../src/memory-store");
const { VirtualTime } = require("../scripts/lib/virtual-time");
const { initLanguageDetector, detectLanguage } = require("../src/language");

const BOT_ID = "17841400000000000";
const START = Date.parse("2026-01-01T10:00:00Z");

const silentLogger = {
  lines: [],
  log(line) {
    this.lines.push(line);
  },
  error(message, error) {
    this.lines.push(`ERROR: ${message} ${error && error.message ? error.message : ""}`);
  },
  userMessage() {},
  automaticMessage(userId) {
    this.lines.push(`auto ${userId}`);
  },
  manualMessage(userId) {
    this.lines.push(`manual ${userId}`);
  },
};

/**
 * A responder wired to fakes: virtual time, in-memory store, recorded sends and
 * Telegram notifications. Nothing leaves the process.
 */
async function makeHarness({ replyMode = "live", testUserIds = [], profiles = {}, failingProfiles = [], engine = {}, sendDelay = null } = {}) {
  await initLanguageDetector();
  const time = new VirtualTime(START);
  const store = new MemoryStore();
  const sent = [];
  const notifications = [];
  const decisions = [];
  const logger = Object.create(silentLogger);
  logger.lines = [];
  let mid = 0;

  const responder = new Responder({
    store,
    profiles: {
      get: async (userId) => {
        if (failingProfiles.includes(userId)) return { status: "failed", profile: { name: null, username: null } };
        return { status: "ok", profile: { name: null, username: `user${userId}`, followerCount: 100, ...(profiles[userId] || {}) } };
      },
    },
    sender: {
      send: async (userId, message) => {
        mid += 1;
        if (sendDelay) await sendDelay();
        const response = { recipient_id: userId, message_id: `mid.bot.${mid}` };
        sent.push({ userId, message, mid: response.message_id, at: time.now() });
        return response;
      },
    },
    notifier: {
      message: async (profile, text) => notifications.push({ type: "message", profile, text, at: time.now() }),
      recipeNotAnswered: async (profile, text, label) => notifications.push({ type: "suppressed", profile, text, label }),
      repeatedReels: async (profile, count) => notifications.push({ type: "escalation", profile, count, at: time.now() }),
      needsHelp: async (profile) => notifications.push({ type: "needs_help", profile }),
    },
    logger,
    clock: time,
    scheduler: time,
    detectLanguage,
    config: { replyMode, testUserIds, botAccountId: BOT_ID, engine: { publicBaseUrl: "https://example.test", ...engine } },
    onDecision: (info) => decisions.push(info),
  });

  let inboundMid = 0;
  const event = (userId, message) => ({
    sender: { id: userId },
    recipient: { id: BOT_ID },
    timestamp: time.now(),
    message: { mid: `mid.user.${++inboundMid}`, ...message },
  });

  const h = {
    time,
    store,
    sent,
    notifications,
    decisions,
    logger,
    responder,
    async at(isoOrMs) {
      await time.advanceTo(typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs));
    },
    async wait(ms) {
      await time.advanceBy(ms);
    },
    reel(userId) {
      return responder.handleWebhookEvent(event(userId, { attachments: [{ type: "ig_reel", payload: { url: "https://lookaside.test/reel" } }] }));
    },
    text(userId, text) {
      return responder.handleWebhookEvent(event(userId, { text }));
    },
    link(userId, url) {
      return responder.handleWebhookEvent(event(userId, { text: url }));
    },
    quickReply(userId, payload, title = "") {
      return responder.handleWebhookEvent(event(userId, { text: title, quick_reply: { payload } }));
    },
    // A message sent from our account (Instagram echo)
    echo(userId, echoMid, text = "Hola") {
      return responder.handleWebhookEvent({
        sender: { id: BOT_ID },
        recipient: { id: userId },
        timestamp: time.now(),
        message: { mid: echoMid, text, is_echo: true },
      });
    },
    sentTo(userId) {
      return sent.filter((s) => s.userId === userId);
    },
    repliesTo(userId) {
      return decisions.filter((d) => d.userId === userId && d.action.type === "reply");
    },
  };
  return h;
}

module.exports = { makeHarness, BOT_ID, START };
