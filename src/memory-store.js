// In-memory implementation of the responder store (same interface as the sqlite
// UserDatabase). Used by the tests and by scripts/replay-log.js.

const { SHARED_FIELDS, MODE_FIELDS, RECIPE_COUNT_WINDOW_MS, splitUpdate } = require("./state-fields");

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

class MemoryStore {
  constructor() {
    this.shared = new Map();
    this.perMode = new Map();
    this.recipes = new Map();
    this.botMessages = new Map();
    this.profiles = new Map();
    this.remyMessages = new Map();
    this.outbox = []; // rows ordered by id
    this.outboxNextId = 0;
    this.idempotency = new Map();
  }

  async getState(userId, stateMode, now) {
    const shared = this.shared.get(userId) || {};
    const perMode = this.perMode.get(`${stateMode}:${userId}`) || {};
    const state = { userId };
    for (const key of Object.keys(SHARED_FIELDS)) state[key] = shared[key] ?? null;
    for (const key of Object.keys(MODE_FIELDS)) state[key] = perMode[key] ?? null;
    state.level = state.level || 0;
    const since = now - RECIPE_COUNT_WINDOW_MS;
    state.recipesLast7Days = (this.recipes.get(userId) || []).filter((at) => at > since).length;
    return state;
  }

  async applyUpdate(userId, stateMode, update) {
    const { shared, perMode } = splitUpdate(update);
    this.shared.set(userId, { ...(this.shared.get(userId) || {}), ...shared });
    const key = `${stateMode}:${userId}`;
    this.perMode.set(key, { ...(this.perMode.get(key) || {}), ...perMode });
  }

  async recordRecipe(userId, at) {
    const list = this.recipes.get(userId) || [];
    list.push(at);
    this.recipes.set(userId, list);
  }

  async recordBotMessage(mid, userId, kind, at) {
    this.botMessages.set(mid, { userId, kind, at });
  }

  async isBotMessage(mid) {
    return this.botMessages.has(mid);
  }

  async recordEcho(_userId) {}

  async getCachedProfile(userId) {
    return this.profiles.get(userId) || null;
  }

  async saveProfile(userId, profile, checkedAt) {
    this.profiles.set(userId, { profile, checkedAt });
  }

  // --- Remy bridge ---

  async recordRemyMessage(mid, userId, at) {
    if (!this.remyMessages.has(mid)) this.remyMessages.set(mid, { userId, at });
  }

  async isRemyMessage(mid) {
    return this.remyMessages.has(mid);
  }

  async outboxAdd({ eventId, account, payload, createdAt }) {
    if (this.outbox.some((row) => row.eventId === eventId)) return false;
    this.outbox.push({
      id: ++this.outboxNextId,
      eventId,
      account: account ?? null,
      payload,
      attempts: 0,
      nextAt: createdAt,
      lastError: null,
      createdAt,
    });
    return true;
  }

  async outboxHead(limit) {
    return this.outbox.slice(0, limit).map((row) => ({ ...row }));
  }

  async outboxDelete(ids) {
    const gone = new Set(ids);
    this.outbox = this.outbox.filter((row) => !gone.has(row.id));
  }

  async outboxFailed(ids, nextAt, error) {
    const failed = new Set(ids);
    for (const row of this.outbox) {
      if (!failed.has(row.id)) continue;
      row.attempts += 1;
      row.nextAt = nextAt;
      row.lastError = error;
    }
  }

  async outboxDropOlderThan(before) {
    const kept = this.outbox.filter((row) => row.createdAt >= before);
    const dropped = this.outbox.length - kept.length;
    this.outbox = kept;
    return dropped;
  }

  async outboxStats() {
    const withError = this.outbox.find((row) => row.lastError !== null);
    return {
      queued: this.outbox.length,
      oldestAt: this.outbox.length > 0 ? Math.min(...this.outbox.map((row) => row.createdAt)) : null,
      lastError: withError ? withError.lastError : null,
    };
  }

  async getIdempotentAnswer(key, now) {
    const entry = this.idempotency.get(key);
    if (!entry || entry.createdAt < now - IDEMPOTENCY_RETENTION_MS) return null;
    return { status: entry.status, body: JSON.parse(entry.body) };
  }

  async saveIdempotentAnswer(key, status, body, now) {
    for (const [k, entry] of this.idempotency) {
      if (entry.createdAt < now - IDEMPOTENCY_RETENTION_MS) this.idempotency.delete(k);
    }
    this.idempotency.set(key, { status, body: JSON.stringify(body), createdAt: now });
  }
}

module.exports = { MemoryStore };
