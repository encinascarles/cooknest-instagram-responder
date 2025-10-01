const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logFile = path.join(__dirname, '..', 'logs', 'bot.log');
    this.ensureLogDir();
  }

  ensureLogDir() {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  formatTimestamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
  }

  truncateMessage(message, maxLength = 60) {
    if (!message || message.length <= maxLength) return message;
    return message.substring(0, maxLength) + '...';
  }

  log(message) {
    const timestamp = this.formatTimestamp();
    const logLine = `[${timestamp}] ${message}`;
    
    // Write to console
    console.log(logLine);
    
    // Write to file
    fs.appendFileSync(this.logFile, logLine + '\n');
  }

  unauthorizedWebhook() {
    this.log('Unauthorized webhook call');
  }

  userMessage(userId, messageText) {
    const truncated = this.truncateMessage(messageText);
    this.log(`User ${userId} sent message "${truncated}"`);
  }

  automaticMessage(userId, messageText) {
    const truncated = this.truncateMessage(messageText);
    this.log(`Automatic message sent by us to ${userId}: "${truncated}"`);
  }

  manualMessage(userId, messageText) {
    const truncated = this.truncateMessage(messageText);
    this.log(`Manual message sent by us to ${userId}: "${truncated}"`);
  }

  error(message, error = null) {
    let logMessage = `ERROR: ${message}`;
    if (error) {
      const serialized = (() => {
        if (typeof error === "string") return error;
        if (error?.response?.data) {
          try {
            return JSON.stringify(error.response.data);
          } catch (_e) {
            return String(error.response.data);
          }
        }
        if (error?.data) {
          try {
            return JSON.stringify(error.data);
          } catch (_e) {
            return String(error.data);
          }
        }
        if (error?.message) return error.message;
        try {
          return JSON.stringify(error);
        } catch (_e) {
          return String(error);
        }
      })();
      logMessage += ` - ${serialized}`;
    }
    this.log(logMessage);
  }
}

const logger = new Logger();

module.exports = { logger };
