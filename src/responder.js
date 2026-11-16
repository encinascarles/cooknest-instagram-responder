// Orchestration around decide(): gathers the state, waits out reel bursts, calls
// the engine and executes the action (send, Telegram, persist). All I/O is
// injected, so the server, the tests and the log replay run this same code.

const { decide, classifyEcho } = require("./engine");
const { classifyMessage } = require("./detect");
const { toRemyProfile } = require("./remy-bridge");

const DEFAULT_DEBOUNCE_MS = 0; // answer at once; later reels are caught by the burst/cooldown rules

// Fields that are facts about the person, kept even when nothing was sent
const OBSERVED_FIELDS = ["lastRecipeAt", "lastFreeTextAt", "lang"];

class Responder {
  /**
   * @param {object} deps
   * @param {object} deps.store MemoryStore or UserDatabase
   * @param {{get: (userId: string, now: number) => Promise<{status: string, profile: object}>}} deps.profiles
   * @param {{send: (userId: string, message: object) => Promise<{message_id?: string}>}} deps.sender
   * @param {{message, recipeNotAnswered, repeatedReels, needsHelp}} deps.notifier Telegram
   * @param {object} deps.logger
   * @param {{now: () => number}} [deps.clock]
   * @param {{setTimeout: (fn: Function, ms: number) => any}} [deps.scheduler]
   * @param {(text: string) => string|null} [deps.detectLanguage]
   * @param {object} [deps.config] replyMode, testUserIds, botAccountId, debounceMs, engine
   * @param {(info: object) => void} [deps.onDecision] called after every decision (replay, tests)
   * @param {(item: object|Promise<object>) => void} [deps.forward] gets every webhook event for
   *   Remy ({account, event, origin, bot, profile}, see README "Remy bridge"). Never awaited:
   *   the bot does not wait on it, and an error in it never reaches the bot.
   */
  constructor({ store, profiles, sender, notifier, logger, clock, scheduler, detectLanguage, config = {}, onDecision, forward }) {
    this.store = store;
    this.profiles = profiles;
    this.sender = sender;
    this.notifier = notifier;
    this.logger = logger;
    this.clock = clock || { now: () => Date.now() };
    this.scheduler = scheduler || { setTimeout: (fn, ms) => setTimeout(fn, ms) };
    this.detectLanguage = detectLanguage || (() => null);
    this.onDecision = onDecision || null;
    this.forward = forward || null;

    this.replyMode = config.replyMode === "live" ? "live" : "shadow";
    this.testUserIds = new Set(config.testUserIds || []);
    this.botAccountId = config.botAccountId || "";
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.engineConfig = config.engine || {};

    this.queues = new Map(); // userId -> promise chain (one event at a time per user)
    this.pendingRecipes = new Map(); // userId -> reels waiting for the debounce timer
    this.inflight = new Map(); // userId -> Set of send promises (echo may arrive before the API answers)
  }

  // "live" state for real sends; "shadow" keeps shadow decisions apart
  stateModeFor(userId) {
    return this.replyMode === "live" || this.testUserIds.has(userId) ? "live" : "shadow";
  }

  /**
   * Handles one entry.messaging[] event from the webhook.
   * Resolves when the event has been processed (a reel only schedules its decision).
   * @param {object} event
   * @param {{account?: string}} [context] the webhook entry's id
   */
  handleWebhookEvent(event, { account } = {}) {
    const senderId = event?.sender?.id;
    const recipientId = event?.recipient?.id;
    const message = event?.message;
    // Reads, reactions, edits, unsends...: the bot ignores them, Remy gets them
    if (!senderId || !recipientId || !message || message.is_deleted || message.is_unsupported) {
      this.forwardOther(event, account);
      return Promise.resolve();
    }

    if ((this.botAccountId && senderId === this.botAccountId) || message.is_echo) {
      return this.guard(recipientId, () => this.handleEcho(recipientId, message, { event, account }));
    }
    return this.queue(senderId, () => this.handleInbound(senderId, message, { event, account }));
  }

  async guard(userId, fn) {
    try {
      await fn();
    } catch (error) {
      this.logger.error(`Error processing event for ${userId}`, error);
    }
  }

  queue(userId, fn) {
    const previous = this.queues.get(userId) || Promise.resolve();
    const next = previous.then(() => this.guard(userId, fn));
    this.queues.set(userId, next);
    next.then(() => {
      if (this.queues.get(userId) === next) this.queues.delete(userId);
    });
    return next;
  }

  async handleEcho(userId, message, { event, account } = {}) {
    let origin = "human";
    try {
      const now = this.clock.now();
      // Our send (or Remy's) may still be waiting for its message_id
      await this.waitInflight(userId);

      const mid = message.mid;
      const isOurs = mid ? await this.store.isBotMessage(mid) : false;
      const text = message.text || "[attachment]";
      if (classifyEcho(mid, isOurs) === "bot") {
        origin = "bot";
        this.logger.automaticMessage(userId, text);
      } else {
        // Sent from Remy or typed on the phone: a human either way, for the bot
        if (this.forward && mid && (await this.isRemyMessage(mid))) origin = "remy";
        this.logger.manualMessage(userId, text);
        await this.store.applyUpdate(userId, this.stateModeFor(userId), { lastHumanAt: now });
      }
      await this.store.recordEcho(userId);
    } finally {
      if (event) this.emit(this.cachedProfile(userId).then((profile) => ({ account, event, origin, bot: null, profile })));
    }
  }

  async handleInbound(userId, message, { event: raw, account } = {}) {
    const inbound = { event: raw, account, classified: null, forwarded: false };
    try {
      const now = this.clock.now();
      const classified = classifyMessage(message);
      inbound.classified = classified.kind;
      const logText =
        classified.kind === "quick_reply"
          ? `${classified.text || ""} [quick_reply ${classified.payload}]`.trim()
          : message.text || "[attachment]";
      this.logger.userMessage(userId, logText);

      const lang = classified.kind !== "quick_reply" && classified.text ? this.detectLanguage(classified.text) : null;

      if (classified.kind === "recipe") {
        await this.store.recordRecipe(userId, now);
        this.addPendingRecipe(userId, { at: now, source: classified.source, lang, text: message.text || "", inbound });
        return;
      }

      let event;
      if (classified.kind === "quick_reply") event = { type: "quick_reply", payload: classified.payload, at: now };
      else if (classified.kind === "text") event = { type: "text", text: classified.text, lang, at: now };
      else event = { type: "other", at: now };

      const state = await this.store.getState(userId, this.stateModeFor(userId), now);
      const action = decide(state, event, now, this.engineConfig);
      await this.execute(userId, action, { event, text: logText, now, inbound: [inbound] });
    } catch (error) {
      this.forwardInbound(userId, [inbound], { error });
      throw error;
    }
  }

  // Burst guard: wait debounceMs after the first reel, then decide once for all of them
  addPendingRecipe(userId, item) {
    const pending = this.pendingRecipes.get(userId);
    if (pending) {
      pending.lastAt = item.at;
      pending.count += 1;
      if (item.source === "share") pending.source = "share";
      pending.lang = pending.lang || item.lang;
      pending.inbound.push(item.inbound);
      return;
    }
    this.pendingRecipes.set(userId, {
      firstAt: item.at,
      lastAt: item.at,
      count: 1,
      source: item.source,
      lang: item.lang,
      text: item.text,
      inbound: [item.inbound],
    });
    this.scheduler.setTimeout(() => this.queue(userId, () => this.flushRecipes(userId)), this.debounceMs);
  }

  async flushRecipes(userId) {
    const pending = this.pendingRecipes.get(userId);
    if (!pending) return;
    this.pendingRecipes.delete(userId);

    try {
      const now = this.clock.now();
      const { status, profile } = await this.profiles.get(userId, now);
      const state = await this.store.getState(userId, this.stateModeFor(userId), now);
      state.profile = profile;
      state.profileStatus = status;

      const event = {
        type: "recipe",
        source: pending.source,
        at: pending.firstAt,
        lastAt: pending.lastAt,
        count: pending.count,
        lang: pending.lang,
      };
      const action = decide(state, event, now, this.engineConfig);
      const text = pending.text || (pending.count > 1 ? `[${pending.count} reels]` : "[reel]");
      await this.execute(userId, action, { event, text, now, profile, profileStatus: status, inbound: pending.inbound });
    } catch (error) {
      // Every reel of the burst gets the burst's outcome
      this.forwardInbound(userId, pending.inbound, { error });
      throw error;
    }
  }

  async execute(userId, action, { event, text, now, profile = null, profileStatus = null, inbound = [] }) {
    const stateMode = this.stateModeFor(userId);
    const shadow = stateMode === "shadow";
    let update = action.update || {};
    let sent = 0;

    if (action.type === "reply") {
      if (shadow) {
        this.logger.log(`[shadow] would send ${action.kind} to ${userId}`);
      } else {
        sent = await this.sendAll(userId, action, now);
        if (sent === 0) {
          update = Object.fromEntries(Object.entries(update).filter(([key]) => OBSERVED_FIELDS.includes(key)));
        }
      }
    } else if (action.type === "silent") {
      this.logger.log(`No auto-reply to ${userId}: ${action.reason}`);
    }

    await this.store.applyUpdate(userId, stateMode, update);

    const bot = botSummary(event.type, action);
    if (this.onDecision) {
      this.onDecision({ userId, event, action, stateMode, sent, at: now, bot, inbound: inbound.map((item) => item.event) });
    }

    if (action.notify) {
      await this.notify(userId, action, { text, now, profile, shadow });
    }

    // After the notification, so its profile lookup has filled the cache
    this.forwardInbound(userId, inbound, { bot, now, profile, profileStatus });
  }

  async sendAll(userId, action, now) {
    let sent = 0;
    for (const message of action.messages) {
      const attempt = (async () => {
        const response = await this.sender.send(userId, message);
        if (response && response.message_id) {
          await this.store.recordBotMessage(response.message_id, userId, action.kind, now);
        }
        return response;
      })();
      this.trackInflight(userId, attempt);
      try {
        await attempt;
        sent += 1;
      } catch (error) {
        this.logger.error(`Failed to send ${action.kind} ${message.video ? "video" : "text"} to ${userId}`, error);
      }
    }
    return sent;
  }

  // A message a human sent from Remy: the same update as an echo typed on the phone
  async recordHumanMessage(userId, at = this.clock.now()) {
    await this.store.applyUpdate(userId, this.stateModeFor(userId), { lastHumanAt: at });
  }

  async waitInflight(userId) {
    const pending = this.inflight.get(userId);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);
  }

  trackInflight(userId, promise) {
    const set = this.inflight.get(userId) || new Set();
    set.add(promise);
    this.inflight.set(userId, set);
    promise
      .catch(() => {})
      .then(() => {
        set.delete(promise);
        if (set.size === 0) this.inflight.delete(userId);
      });
  }

  async notify(userId, action, { text, now, profile, shadow }) {
    const { notify } = action;
    // New kinds of alerts only for users the new engine really talks to
    if (shadow && notify.type !== "message") {
      this.logger.log(`[shadow] would notify ${notify.type} for ${userId}`);
      return;
    }
    try {
      const userProfile = profile || (await this.profiles.get(userId, now)).profile;
      if (notify.type === "message") await this.notifier.message(userProfile, text);
      else if (notify.type === "suppressed") await this.notifier.recipeNotAnswered(userProfile, text, notify.label);
      else if (notify.type === "escalation") await this.notifier.repeatedReels(userProfile, notify.reelsThisWeek);
      else if (notify.type === "needs_help") await this.notifier.needsHelp(userProfile);
    } catch (error) {
      this.logger.error("Failed to send Telegram notification", error);
    }
  }

  // --- Remy bridge: nothing below may throw into the bot or make it wait ---

  emit(item) {
    if (!this.forward) return;
    try {
      this.forward(item);
    } catch (error) {
      this.logger.error("Failed to forward an event to Remy", error);
    }
  }

  isFromUs(event, account) {
    const senderId = event?.sender?.id;
    if (!senderId) return false;
    return Boolean(event?.message?.is_echo || senderId === this.botAccountId || (account && senderId === account));
  }

  // Events the bot does not act on: unsends, unsupported messages, reads, reactions, edits...
  forwardOther(event, account) {
    if (!this.forward || !event || typeof event !== "object") return;
    const ours = this.isFromUs(event, account);
    const userId = ours ? event.recipient?.id : event.sender?.id;
    const mid = event.message?.mid;
    const item = (async () => {
      let origin = "user";
      if (ours) origin = mid ? await this.echoOrigin(userId, mid) : "human";
      return { account, event, origin, bot: null, profile: await this.cachedProfile(userId) };
    })();
    this.emit(item.catch(() => ({ account, event, origin: ours ? "human" : "user", bot: null, profile: null })));
  }

  // "bot", "remy" or "human" for a message sent from our account
  async echoOrigin(userId, mid) {
    try {
      if (userId) await this.waitInflight(userId);
      if (await this.store.isBotMessage(mid)) return "bot";
      if (await this.isRemyMessage(mid)) return "remy";
    } catch (error) {
      this.logger.error(`Failed to classify a message from our account for ${userId}`, error);
    }
    return "human";
  }

  async isRemyMessage(mid) {
    if (typeof this.store.isRemyMessage !== "function") return false;
    try {
      return await this.store.isRemyMessage(mid);
    } catch (error) {
      this.logger.error("Failed to read remy_messages", error);
      return false;
    }
  }

  // The cached profile in Remy's shape, or null (also for a row with nothing in it); never rejects
  cachedProfile(userId) {
    if (!userId || typeof this.store.getCachedProfile !== "function") return Promise.resolve(null);
    return Promise.resolve()
      .then(() => this.store.getCachedProfile(userId))
      .then((cached) => {
        const profile = cached && cached.profile;
        if (!profile) return null;
        const known = typeof cached.checkedAt === "number" || profile.username || profile.name;
        return known ? toRemyProfile(userId, profile) : null;
      })
      .catch(() => null);
  }

  // The profile the decision used, else the 24 h cache or a fetch; null when it failed
  inboundProfile(userId, now, profile, profileStatus) {
    if (profileStatus === "ok") return Promise.resolve(toRemyProfile(userId, profile));
    if (profileStatus === "failed") return Promise.resolve(null);
    return Promise.resolve()
      .then(() => this.profiles.get(userId, now ?? this.clock.now()))
      .then((result) => (result && result.status === "ok" ? toRemyProfile(userId, result.profile) : null))
      .catch(() => null);
  }

  /**
   * Inbound messages go to Remy once the bot has decided on them (or failed to),
   * each with the decision of its group (a reel burst shares one).
   */
  forwardInbound(userId, inbound, { bot = null, error = null, now, profile = null, profileStatus = null }) {
    if (!this.forward || !Array.isArray(inbound)) return;
    const items = inbound.filter((item) => item && item.event && !item.forwarded);
    if (items.length === 0) return;
    for (const item of items) item.forwarded = true;
    const profilePromise = this.inboundProfile(userId, now, profile, profileStatus);
    for (const item of items) {
      const summary = error
        ? { classified: item.classified || "other", decision: "error", kind: null, reason: errorReason(error) }
        : { ...bot, classified: item.classified || bot.classified };
      this.emit(profilePromise.then((remyProfile) => ({ account: item.account, event: item.event, origin: "user", bot: summary, profile: remyProfile })));
    }
  }
}

// What Remy learns about the bot's decision
function botSummary(eventType, action) {
  return {
    classified: ["recipe", "text", "quick_reply"].includes(eventType) ? eventType : "other",
    decision: action.type === "reply" ? "reply" : "silent",
    kind: action.kind ?? null,
    reason: action.reason ?? null,
  };
}

function errorReason(error) {
  const text = (error && error.message) || String(error);
  return Array.from(text).slice(0, 200).join("");
}

module.exports = { Responder, DEFAULT_DEBOUNCE_MS };
