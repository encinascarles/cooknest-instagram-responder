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
    if (!message) return message;
    const chars = Array.from(message); // do not cut an emoji in half
    if (chars.length <= maxLength) return message;
    return chars.slice(0, maxLength).join('') + '...';
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
    const detail = describeError(error);
    this.log(detail ? `ERROR: ${message} - ${detail}` : `ERROR: ${message}`);
  }
}

/**
 * Turns any thrown value (axios error, AggregateError, plain object, string) into
 * a readable one-line description, including the HTTP status and response body,
 * the error code and the cause.
 */
function describeError(error) {
  if (error === null || error === undefined || error === "") return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const parts = [];
  if (error.response) {
    const { status, data } = error.response;
    if (status) parts.push(`HTTP ${status}`);
    if (data !== undefined) parts.push(typeof data === "string" ? data : safeJson(data));
  }
  const isError = error instanceof Error;
  if (isError && error.name && error.name !== "Error") parts.push(error.name);
  if (error.code) parts.push(String(error.code));
  if (error.message) parts.push(error.message);
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) parts.push(describeError(inner));
  }
  if (error.cause) parts.push(`cause: ${describeError(error.cause)}`);
  if (parts.length === 0) {
    parts.push(isError ? error.name || "Error (no message)" : safeJson(error));
  }
  return parts.filter(Boolean).join(" | ");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
}

const logger = new Logger();

module.exports = { logger, describeError };
