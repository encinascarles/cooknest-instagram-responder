// In-memory implementation of the responder store (same interface as the sqlite
// UserDatabase). Used by the tests and by scripts/replay-log.js.

const { SHARED_FIELDS, MODE_FIELDS, RECIPE_COUNT_WINDOW_MS, splitUpdate } = require("./state-fields");

class MemoryStore {
  constructor() {
    this.shared = new Map();
    this.perMode = new Map();
    this.recipes = new Map();
    this.botMessages = new Map();
    this.profiles = new Map();
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
}

module.exports = { MemoryStore };
