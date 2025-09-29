const axios = require('axios');
const { logger } = require('./logger');

class TelegramNotifier {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
  }

  isConfigured() {
    return this.botToken && this.chatId;
  }

  async sendMessage(text) {
    if (!this.isConfigured()) {
      logger.error('Telegram not configured - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }, {
        timeout: 10000
      });
    } catch (error) {
      logger.error('Failed to send Telegram notification', error?.response?.data || error?.message);
    }
  }

  async notifyImportantMessage(userProfile, messageText) {
    if (!this.isConfigured()) return;

    const fullName = userProfile.full_name || 'Unknown User';
    const username = userProfile.username;
    const truncatedMessage = messageText.length > 100 ? messageText.substring(0, 100) + '...' : messageText;

    let nameWithLink;
    if (username) {
      // Create clickable link to Instagram web profile
      nameWithLink = `<a href="https://instagram.com/${username}"><b>${fullName}</b></a>`;
    } else {
      // No username available, just bold name
      nameWithLink = `<b>${fullName}</b>`;
    }

    const message = `${nameWithLink}: ${truncatedMessage}`;

    await this.sendMessage(message);
  }

  async notifyError(errorMessage) {
    if (!this.isConfigured()) return;

    const message = `❌ <b>Bot Error</b>

⚠️ ${errorMessage}

🔧 Check logs for details`;

    await this.sendMessage(message);
  }
}

const telegramNotifier = new TelegramNotifier();

module.exports = { telegramNotifier };
