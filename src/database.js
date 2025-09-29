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
        first_reel_sent DATETIME
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
