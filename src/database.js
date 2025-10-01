const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class UserDatabase {
  constructor() {
    const dbPath = path.join(__dirname, '..', 'users.db');
    this.db = new sqlite3.Database(dbPath);
    this.init();
  }

  init() {
    const createTable = `
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
    `;
    
    this.db.run(createTable, (err) => {
      if (err) {
        console.error('Error creating users table:', err);
      } else {
        // Add new columns if they don't exist (for existing databases)
        this.db.run(`ALTER TABLE users ADD COLUMN last_sent DATETIME`, (alterErr) => {
          // Ignore error if column already exists
          if (alterErr && !alterErr.message.includes('duplicate column name')) {
            console.error('Error adding last_sent column:', alterErr);
          }
        });
        this.db.run(`ALTER TABLE users ADD COLUMN first_reel_sent DATETIME`, (alterErr) => {
          // Ignore error if column already exists
          if (alterErr && !alterErr.message.includes('duplicate column name')) {
            console.error('Error adding first_reel_sent column:', alterErr);
          }
        });
        // Add profile columns
        const profileColumns = ['username TEXT', 'full_name TEXT', 'profile_pic TEXT', 'last_profile_update DATETIME'];
        profileColumns.forEach(column => {
          this.db.run(`ALTER TABLE users ADD COLUMN ${column}`, (alterErr) => {
            // Ignore error if column already exists
            if (alterErr && !alterErr.message.includes('duplicate column name')) {
              console.error(`Error adding ${column} column:`, alterErr);
            }
          });
        });
        this.db.run(`CREATE TABLE IF NOT EXISTS instagram_token (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            access_token TEXT NOT NULL,
            expires_at DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`, (alterErr) => {
          if (alterErr) {
            console.error('Error creating instagram_token table:', alterErr);
          }
        });
      }
    });
  }

  async isNewUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT user_id FROM users WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!row); // true if user doesn't exist (is new)
          }
        }
      );
    });
  }

  async isFirstTimeReelUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT first_reel_sent FROM users WHERE user_id = ? AND first_reel_sent IS NOT NULL',
        [userId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!row); // true if no reel has been sent before
          }
        }
      );
    });
  }

  async recordMessageSent(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (user_id, last_sent) 
         VALUES (?, CURRENT_TIMESTAMP) 
         ON CONFLICT(user_id) DO UPDATE SET 
           last_sent = CURRENT_TIMESTAMP,
           message_count = message_count + 1`,
        [userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  async recordReelMessageSent(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (user_id, last_sent, first_reel_sent) 
         VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
         ON CONFLICT(user_id) DO UPDATE SET 
           last_sent = CURRENT_TIMESTAMP,
           first_reel_sent = COALESCE(first_reel_sent, CURRENT_TIMESTAMP),
           message_count = message_count + 1`,
        [userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  async updateUserProfile(userId, profileData) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (user_id, username, full_name, profile_pic, last_profile_update) 
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) 
         ON CONFLICT(user_id) DO UPDATE SET 
           username = ?,
           full_name = ?,
           profile_pic = ?,
           last_profile_update = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId, profileData.username, profileData.full_name, profileData.profile_pic,
         profileData.username, profileData.full_name, profileData.profile_pic, userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  async getUserProfile(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT user_id, username, full_name, profile_pic, last_profile_update FROM users WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async saveInstagramToken(accessToken, expiresAt) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO instagram_token (id, access_token, expires_at, updated_at)
           VALUES (1, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET
             access_token = excluded.access_token,
             expires_at = excluded.expires_at,
             updated_at = CURRENT_TIMESTAMP`,
        [accessToken, expiresAt || null],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  async getInstagramToken() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT access_token, expires_at, updated_at
           FROM instagram_token
           WHERE id = 1`,
        [],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async shouldSendAck(userId, windowDays) {
    return new Promise((resolve, reject) => {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - windowDays);
      
      this.db.get(
        `SELECT user_id FROM users 
         WHERE user_id = ? AND last_sent > ?`,
        [userId, windowStart.toISOString()],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!row); // true if no message sent in the last windowDays
          }
        }
      );
    });
  }

  close() {
    this.db.close();
  }
}

const userDb = new UserDatabase();

module.exports = { userDb };
