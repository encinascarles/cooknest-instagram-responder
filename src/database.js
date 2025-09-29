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
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 1
      )
    `;
    
    this.db.run(createTable, (err) => {
      if (err) {
        console.error('Error creating users table:', err);
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

  async recordUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (user_id) 
         VALUES (?) 
         ON CONFLICT(user_id) DO UPDATE SET 
           last_seen = CURRENT_TIMESTAMP,
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

  close() {
    this.db.close();
  }
}

const userDb = new UserDatabase();

module.exports = { userDb };
