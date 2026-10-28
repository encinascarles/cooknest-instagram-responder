// Orchestration around decide(): gathers the state, waits out reel bursts, calls
// the engine and executes the action (send, Telegram, persist). All I/O is
// injected, so the server, the tests and the log replay run this same code.

const { decide, classifyEcho } = require("./engine");
const { classifyMessage } = require("./detect");

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
   */
  constructor({ store, profiles, sender, notifier, logger, clock, scheduler, detectLanguage, config = {}, onDecision }) {
    this.store = store;
    this.profiles = profiles;
    this.sender = sender;
    this.notifier = notifier;
    this.logger = logger;
    this.clock = clock || { now: () => Date.now() };
    this.scheduler = scheduler || { setTimeout: (fn, ms) => setTimeout(fn, ms) };
    this.detectLanguage = detectLanguage || (() => null);
    this.onDecision = onDecision || null;

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
   */
  handleWebhookEvent(event) {
    const senderId = event?.sender?.id;
    const recipientId = event?.recipient?.id;
    const message = event?.message;
    if (!senderId || !recipientId || !message) return Promise.resolve();
    if (message.is_deleted || message.is_unsupported) return Promise.resolve();

    if ((this.botAccountId && senderId === this.botAccountId) || message.is_echo) {
      return this.guard(recipientId, () => this.handleEcho(recipientId, message));
    }
    return this.queue(senderId, () => this.handleInbound(senderId, message));
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

  async handleEcho(userId, message) {
    const now = this.clock.now();
    // Our send may still be waiting for its message_id
    const pending = this.inflight.get(userId);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);

    const mid = message.mid;
    const isOurs = mid ? await this.store.isBotMessage(mid) : false;
    const text = message.text || "[attachment]";
    if (classifyEcho(mid, isOurs) === "bot") {
      this.logger.automaticMessage(userId, text);
    } else {
      this.logger.manualMessage(userId, text);
      await this.store.applyUpdate(userId, this.stateModeFor(userId), { lastHumanAt: now });
    }
    await this.store.recordEcho(userId);
  }

  async handleInbound(userId, message) {
    const now = this.clock.now();
    const classified = classifyMessage(message);
    const logText =
      classified.kind === "quick_reply"
        ? `${classified.text || ""} [quick_reply ${classified.payload}]`.trim()
        : message.text || "[attachment]";
    this.logger.userMessage(userId, logText);

    const lang = classified.kind !== "quick_reply" && classified.text ? this.detectLanguage(classified.text) : null;

    if (classified.kind === "recipe") {
      await this.store.recordRecipe(userId, now);
      this.addPendingRecipe(userId, { at: now, source: classified.source, lang, text: message.text || "" });
      return;
    }

    let event;
    if (classified.kind === "quick_reply") event = { type: "quick_reply", payload: classified.payload, at: now };
    else if (classified.kind === "text") event = { type: "text", text: classified.text, lang, at: now };
    else event = { type: "other", at: now };

    const state = await this.store.getState(userId, this.stateModeFor(userId), now);
    const action = decide(state, event, now, this.engineConfig);
    await this.execute(userId, action, { event, text: logText, now });
  }

  // Burst guard: wait debounceMs after the first reel, then decide once for all of them
  addPendingRecipe(userId, item) {
    const pending = this.pendingRecipes.get(userId);
    if (pending) {
      pending.lastAt = item.at;
      pending.count += 1;
      if (item.source === "share") pending.source = "share";
      pending.lang = pending.lang || item.lang;
      return;
    }
    this.pendingRecipes.set(userId, {
      firstAt: item.at,
      lastAt: item.at,
      count: 1,
      source: item.source,
      lang: item.lang,
      text: item.text,
    });
    this.scheduler.setTimeout(() => this.queue(userId, () => this.flushRecipes(userId)), this.debounceMs);
  }

  async flushRecipes(userId) {
    const pending = this.pendingRecipes.get(userId);
    if (!pending) return;
    this.pendingRecipes.delete(userId);

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
    await this.execute(userId, action, { event, text, now, profile });
  }

  async execute(userId, action, { event, text, now, profile = null }) {
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

    if (this.onDecision) {
      this.onDecision({ userId, event, action, stateMode, sent, at: now });
    }

    if (action.notify) {
      await this.notify(userId, action, { text, now, profile, shadow });
    }
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
}

module.exports = { Responder, DEFAULT_DEBOUNCE_MS };
