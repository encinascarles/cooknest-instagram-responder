const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { SHARED_FIELDS, MODE_FIELDS, RECIPE_COUNT_WINDOW_MS, RECIPE_RETENTION_MS, splitUpdate } = require('./state-fields');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'users.db');
const BOT_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Columns added to the original users table. Migrations are additive only: the
// production users.db keeps working with older versions of the bot.
const USER_COLUMNS = [
  ['last_sent', 'DATETIME'],
  ['first_reel_sent', 'DATETIME'],
  ['username', 'TEXT'],
  ['full_name', 'TEXT'],
  ['profile_pic', 'TEXT'],
  ['last_profile_update', 'DATETIME'],
  ['lang', 'TEXT'],
  ['last_free_text_at', 'INTEGER'],
  ['last_human_at', 'INTEGER'],
  ['follower_count', 'INTEGER'],
  ['is_business_follow_user', 'INTEGER'],
  ['is_verified_user', 'INTEGER'],
  ['is_user_follow_business', 'INTEGER'],
  ['profile_checked_at', 'INTEGER'],
];

function toBoolean(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

function toInteger(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

class UserDatabase {
  constructor(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
    this.db = new sqlite3.Database(dbPath);
    this.ready = this.init();
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  async init() {
    try {
      await this.run(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_sent DATETIME DEFAULT CURRENT_TIMESTAMP,
          message_count INTEGER DEFAULT 1,
          first_reel_sent DATETIME,
          username TEXT,
          full_name TEXT,
          profile_pic TEXT,
          last_profile_update DATETIME
        )
      `);
      const existing = new Set((await this.all('PRAGMA table_info(users)')).map((column) => column.name));
      for (const [name, type] of USER_COLUMNS) {
        if (!existing.has(name)) {
          await this.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        }
      }
      await this.run(`CREATE TABLE IF NOT EXISTS instagram_token (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token TEXT NOT NULL,
          expires_at DATETIME,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
      // Reply history per mode ("live" or "shadow"), see state-fields.js
      await this.run(`CREATE TABLE IF NOT EXISTS reply_state (
          user_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          level INTEGER DEFAULT 0,
          level1_sent_at INTEGER,
          last_reply_at INTEGER,
          last_recipe_at INTEGER,
          last_level1_variant INTEGER,
          last_level2_variant INTEGER,
          last_escalation_notify_at INTEGER,
          PRIMARY KEY (user_id, mode)
        )`);
      // Message ids returned by the send API: an echo with any other mid is a human
      await this.run(`CREATE TABLE IF NOT EXISTS bot_messages (
          mid TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT,
          sent_at INTEGER NOT NULL
        )`);
      await this.run(`CREATE TABLE IF NOT EXISTS recipe_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          received_at INTEGER NOT NULL
        )`);
      await this.run('CREATE INDEX IF NOT EXISTS recipe_events_user ON recipe_events (user_id, received_at)');
    } catch (err) {
      console.error('Error migrating users.db:', err);
      throw err;
    }
  }

  // --- Responder store (same interface as MemoryStore) ---

  async getState(userId, stateMode, now) {
    await this.ready;
    const sharedColumns = Object.values(SHARED_FIELDS).join(', ');
    const modeColumns = Object.values(MODE_FIELDS).join(', ');
    const shared = (await this.get(`SELECT ${sharedColumns} FROM users WHERE user_id = ?`, [userId])) || {};
    const perMode =
      (await this.get(`SELECT ${modeColumns} FROM reply_state WHERE user_id = ? AND mode = ?`, [userId, stateMode])) || {};
    const { count } = await this.get(
      'SELECT COUNT(*) AS count FROM recipe_events WHERE user_id = ? AND received_at > ?',
      [userId, now - RECIPE_COUNT_WINDOW_MS]
    );

    const state = { userId };
    for (const [key, column] of Object.entries(SHARED_FIELDS)) state[key] = shared[column] ?? null;
    for (const [key, column] of Object.entries(MODE_FIELDS)) state[key] = perMode[column] ?? null;
    state.level = state.level || 0;
    state.recipesLast7Days = count;
    return state;
  }

  async applyUpdate(userId, stateMode, update) {
    await this.ready;
    const { shared, perMode } = splitUpdate(update);

    const sharedKeys = Object.keys(shared);
    if (sharedKeys.length > 0) {
      const columns = sharedKeys.map((key) => SHARED_FIELDS[key]);
      await this.run(
        `INSERT INTO users (user_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
         ON CONFLICT(user_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}`,
        [userId, ...sharedKeys.map((key) => shared[key])]
      );
    }

    const modeKeys = Object.keys(perMode);
    if (modeKeys.length > 0) {
      const columns = modeKeys.map((key) => MODE_FIELDS[key]);
      await this.run(
        `INSERT INTO reply_state (user_id, mode, ${columns.join(', ')}) VALUES (?, ?, ${columns.map(() => '?').join(', ')})
         ON CONFLICT(user_id, mode) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}`,
        [userId, stateMode, ...modeKeys.map((key) => perMode[key])]
      );
    }
  }

  async recordRecipe(userId, at) {
    await this.ready;
    await this.run('INSERT INTO recipe_events (user_id, received_at) VALUES (?, ?)', [userId, at]);
    await this.run('DELETE FROM recipe_events WHERE user_id = ? AND received_at < ?', [userId, at - RECIPE_RETENTION_MS]);
  }

  async recordBotMessage(mid, userId, kind, at) {
    await this.ready;
    await this.run('INSERT OR IGNORE INTO bot_messages (mid, user_id, kind, sent_at) VALUES (?, ?, ?, ?)', [
      mid,
      userId,
      kind,
      at,
    ]);
    await this.run('DELETE FROM bot_messages WHERE sent_at < ?', [at - BOT_MESSAGE_RETENTION_MS]);
  }

  async isBotMessage(mid) {
    await this.ready;
    return Boolean(await this.get('SELECT mid FROM bot_messages WHERE mid = ?', [mid]));
  }

  // Any message sent from our account (bot or human) updates last_sent, as before
  async recordEcho(userId) {
    await this.ready;
    await this.run(
      `INSERT INTO users (user_id, last_sent)
       VALUES (?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         last_sent = CURRENT_TIMESTAMP,
         message_count = message_count + 1`,
      [userId]
    );
  }

  async getCachedProfile(userId) {
    await this.ready;
    const row = await this.get(
      `SELECT username, full_name, follower_count, is_business_follow_user, is_verified_user,
              is_user_follow_business, profile_checked_at
         FROM users WHERE user_id = ?`,
      [userId]
    );
    if (!row) return null;
    return {
      profile: {
        name: row.full_name ?? null,
        username: row.username ?? null,
        followerCount: row.follower_count ?? null,
        isBusinessFollowUser: toBoolean(row.is_business_follow_user),
        isVerifiedUser: toBoolean(row.is_verified_user),
        isUserFollowBusiness: toBoolean(row.is_user_follow_business),
      },
      checkedAt: row.profile_checked_at ?? null,
    };
  }

  async saveProfile(userId, profile, checkedAt) {
    await this.ready;
    await this.run(
      `INSERT INTO users (user_id, username, full_name, follower_count, is_business_follow_user,
                          is_verified_user, is_user_follow_business, profile_checked_at, last_profile_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         full_name = excluded.full_name,
         follower_count = excluded.follower_count,
         is_business_follow_user = excluded.is_business_follow_user,
         is_verified_user = excluded.is_verified_user,
         is_user_follow_business = excluded.is_user_follow_business,
         profile_checked_at = excluded.profile_checked_at,
         last_profile_update = CURRENT_TIMESTAMP`,
      [
        userId,
        profile.username ?? null,
        profile.name ?? null,
        profile.followerCount ?? null,
        toInteger(profile.isBusinessFollowUser),
        toInteger(profile.isVerifiedUser),
        toInteger(profile.isUserFollowBusiness),
        checkedAt,
      ]
    );
  }

  // --- Instagram token (single account) ---

  async saveInstagramToken(accessToken, expiresAt) {
    await this.ready;
    const result = await this.run(
      `INSERT INTO instagram_token (id, access_token, expires_at, updated_at)
         VALUES (1, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           expires_at = excluded.expires_at,
           updated_at = CURRENT_TIMESTAMP`,
      [accessToken, expiresAt || null]
    );
    return result.changes;
  }

  async getInstagramToken() {
    await this.ready;
    return this.get(
      `SELECT access_token, expires_at, updated_at
         FROM instagram_token
         WHERE id = 1`
    );
  }

  close() {
    return new Promise((resolve) => this.db.close(() => resolve()));
  }
}

// Opened on first use, so requiring this module (tests) does not create users.db
let defaultDb = null;

module.exports = {
  UserDatabase,
  get userDb() {
    if (!defaultDb) defaultDb = new UserDatabase();
    return defaultDb;
  },
};
