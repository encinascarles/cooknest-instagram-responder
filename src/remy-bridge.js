// Forwards every Instagram messaging event to Remy (see README "Remy bridge").
// The bot never waits on Remy: enqueue() appends to the persistent outbox
// (remy_outbox) and returns at once; a background sender posts the events in
// order, in batches, with backoff, and gives up on an event after 48 h.

const crypto = require("crypto");
const { signedHeaders } = require("./remy-signature");
const { describeError } = require("./logger");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const DEFAULTS = {
  batchSize: 50,
  baseDelayMs: 10 * SECOND,
  maxDelayMs: 30 * MINUTE,
  giveUpMs: 48 * HOUR,
};

const ENVELOPE_KEYS = new Set(["sender", "recipient", "timestamp"]);

/**
 * Stable id of a messaging event; Remy dedupes by it.
 *   message, echo, is_unsupported  <mid>
 *   unsend (message.is_deleted)    deleted:<mid>
 *   message_edit                   edit:<mid>:<timestamp>
 *   reaction                       reaction:<mid>:<action>:<timestamp>
 *   read / messaging_seen          read:<mid or watermark>:<timestamp>
 *   anything else                  <kind>:<sha1 of the event's JSON>
 */
function eventId(event) {
  const timestamp = event?.timestamp ?? "";
  const message = event?.message;
  if (message && message.mid) return message.is_deleted ? `deleted:${message.mid}` : message.mid;
  if (event?.message_edit?.mid) return `edit:${event.message_edit.mid}:${timestamp}`;
  if (event?.reaction?.mid) return `reaction:${event.reaction.mid}:${event.reaction.action || "react"}:${timestamp}`;
  const read = event?.read || event?.messaging_seen;
  if (read) return `read:${read.mid || read.watermark || ""}:${timestamp}`;
  const kind = Object.keys(event || {}).find((key) => !ENVELOPE_KEYS.has(key)) || "event";
  return `${kind}:${crypto.createHash("sha1").update(JSON.stringify(event ?? null)).digest("hex")}`;
}

// The profile as Remy gets it
function toRemyProfile(igsid, profile) {
  if (!igsid || !profile) return null;
  return {
    igsid,
    username: profile.username ?? null,
    name: profile.name ?? null,
    followerCount: profile.followerCount ?? null,
    isVerifiedUser: profile.isVerifiedUser ?? null,
    isUserFollowBusiness: profile.isUserFollowBusiness ?? null,
    isBusinessFollowUser: profile.isBusinessFollowUser ?? null,
    profilePic: profile.profilePic ?? null,
  };
}

// POST with Node's fetch; any answer is {status}, a network error throws
async function fetchPost(url, body, headers) {
  const response = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(20 * SECOND) });
  await response.arrayBuffer().catch(() => null);
  return { status: response.status };
}

class RemyBridge {
  /**
   * @param {object} deps
   * @param {object} deps.store outbox store (UserDatabase or MemoryStore)
   * @param {string} deps.url REMY_FORWARD_URL
   * @param {string} deps.secret REMY_BRIDGE_SECRET
   * @param {string} [deps.account] INSTAGRAM_ACCOUNT_ID (else the webhook entry's id)
   * @param {(url: string, body: string, headers: object) => Promise<{status: number}>} [deps.post]
   * @param {{now: () => number}} [deps.clock]
   * @param {{setTimeout: (fn: Function, ms: number) => any}} [deps.scheduler]
   * @param {(text: string) => Promise<void>} [deps.notify] one Telegram line
   * @param {object} [deps.logger]
   */
  constructor({ store, url, secret, account, post, clock, scheduler, notify, logger, ...options }) {
    this.store = store;
    this.url = url;
    this.secret = secret;
    this.account = account || "";
    this.post = post || fetchPost;
    this.clock = clock || { now: () => Date.now() };
    this.scheduler = scheduler || { setTimeout: (fn, ms) => setTimeout(fn, ms) };
    this.notify = notify || (async () => {});
    this.logger = logger || { log() {}, error() {} };
    this.options = { ...DEFAULTS, ...options };

    this.writes = Promise.resolve(); // outbox inserts, in call order
    this.flushing = null;
    this.flushAgain = false;
    this.started = false;
    this.wakeAt = null; // time of the pending sender timer
    this.lastOkAt = null;
    this.lastError = null;
    this.gaveUpNotified = false; // one Telegram line per outage
  }

  /**
   * Queues one event. Returns at once; never throws, never rejects.
   * @param {object|Promise<object>} item {account?, event, origin, bot, profile}, or a
   *   promise of it (kept in call order). A null item is skipped.
   */
  enqueue(item) {
    let ready;
    try {
      ready = Promise.resolve(item).catch((error) => {
        this.logger.error("Remy bridge: could not build an event", error);
        return null;
      });
    } catch (error) {
      return this.writes;
    }
    this.writes = this.writes
      .then(async () => {
        const value = await ready;
        if (!value || !value.event) return;
        await this.add(value);
        this.kick();
      })
      .catch((error) => this.logger.error("Remy bridge: could not queue an event", error));
    return this.writes;
  }

  async add({ account, event, origin, bot = null, profile = null }) {
    const id = eventId(event);
    const payload = JSON.stringify({ id, event, origin, bot: bot || null, profile: profile || null });
    await this.store.outboxAdd({ eventId: id, account: this.account || account || "", payload, createdAt: this.clock.now() });
  }

  // Resolves when every enqueue() so far is in the outbox
  async settled() {
    await this.writes;
  }

  start() {
    this.started = true;
    this.kick();
  }

  kick() {
    if (this.started) this.wake(this.clock.now());
  }

  // One pending timer at a time, at the earliest time asked for
  wake(at) {
    if (this.wakeAt !== null && this.wakeAt <= at) return;
    this.wakeAt = at;
    const delay = Math.max(0, at - this.clock.now());
    this.scheduler.setTimeout(() => {
      if (this.wakeAt !== at) return; // replaced by an earlier timer
      this.wakeAt = null;
      return this.flush();
    }, delay);
  }

  // Sends every due batch; resolves when the outbox is empty or waiting for a retry
  flush() {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.sendDue();
        } while (this.flushAgain);
      } catch (error) {
        this.logger.error("Remy bridge: sender failed", error);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async sendDue() {
    for (;;) {
      const rows = await this.store.outboxHead(this.options.batchSize);
      if (rows.length === 0) return;
      const now = this.clock.now();
      if (rows[0].nextAt > now) {
        if (this.started) this.wake(rows[0].nextAt);
        return;
      }
      // In order, one account per POST
      const batch = [];
      for (const row of rows) {
        if (row.account !== rows[0].account) break;
        batch.push(row);
      }
      const ids = batch.map((row) => row.id);
      const error = await this.deliver(rows[0].account, batch);
      if (!error) {
        await this.store.outboxDelete(ids);
        this.lastOkAt = this.clock.now();
        this.lastError = null;
        this.gaveUpNotified = false;
        continue;
      }

      const attempts = rows[0].attempts + 1;
      const delay = Math.min(this.options.baseDelayMs * 2 ** (attempts - 1), this.options.maxDelayMs);
      this.lastError = error;
      await this.store.outboxFailed(ids, now + delay, error);
      await this.giveUp(now);
      if (this.started) this.wake(now + delay);
      return;
    }
  }

  // Returns null when Remy took the batch, else the error
  async deliver(account, rows) {
    const body = JSON.stringify({
      account: account || this.account,
      sentAt: new Date(this.clock.now()).toISOString(),
      events: rows.map((row) => JSON.parse(row.payload)),
    });
    const headers = { "Content-Type": "application/json", ...signedHeaders(this.secret, body, this.clock.now()) };
    try {
      const response = await this.post(this.url, body, headers);
      const status = response && response.status;
      if (status >= 200 && status < 300) return null;
      return `HTTP ${status}`;
    } catch (error) {
      return describeError(error) || "network error";
    }
  }

  async giveUp(now) {
    const dropped = await this.store.outboxDropOlderThan(now - this.options.giveUpMs);
    if (dropped === 0) return;
    this.logger.error(`Remy bridge: dropped ${dropped} events not delivered in 48 h (${this.lastError})`);
    if (this.gaveUpNotified) return;
    this.gaveUpNotified = true;
    try {
      await this.notify(
        `⚠️ Remy bridge: ${dropped} Instagram events could not be delivered to Remy in 48 h and were dropped (last error: ${this.lastError}). More may follow until Remy answers again.`
      );
    } catch (error) {
      this.logger.error("Remy bridge: could not notify Telegram", error);
    }
  }

  // For GET /internal/remy/health
  async health() {
    const stats = await this.store.outboxStats();
    return {
      queued: stats.queued,
      oldestAt: stats.oldestAt === null ? null : new Date(stats.oldestAt).toISOString(),
      lastOkAt: this.lastOkAt === null ? null : new Date(this.lastOkAt).toISOString(),
      lastError: this.lastError || stats.lastError || null,
    };
  }
}

module.exports = { RemyBridge, eventId, toRemyProfile, fetchPost, DEFAULTS };
