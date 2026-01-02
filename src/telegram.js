const axios = require('axios');
const { logger } = require('./logger');
const { isExcludedMessage } = require('./detect');

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

    // Check if message should be excluded (spam filter)
    if (isExcludedMessage(messageText)) {
      logger.info('Message excluded by spam filter', { messageText: messageText?.substring(0, 50) });
      return;
    }

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

  async notifyError(errorType, errorMessage, additionalInfo = '') {
    if (!this.isConfigured()) return;

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    let emoji = '❌';
    let title = 'Bot Error';
    
    // Customize based on error type
    switch (errorType) {
      case 'token_expired':
        emoji = '🔐';
        title = 'Token Expired';
        break;
      case 'token_refresh_failed':
        emoji = '🔄';
        title = 'Token Refresh Failed';
        break;
      case 'send_message_failed':
        emoji = '💬';
        title = 'Failed to Send Message';
        break;
      case 'api_error':
        emoji = '🌐';
        title = 'API Error';
        break;
      case 'database_error':
        emoji = '💾';
        title = 'Database Error';
        break;
    }

    let message = `${emoji} <b>${title}</b>\n\n`;
    message += `⚠️ ${errorMessage}\n`;
    
    if (additionalInfo) {
      message += `\nℹ️ ${additionalInfo}\n`;
    }
    
    message += `\n🕐 ${timestamp}`;

    await this.sendMessage(message);
  }

  async notifyTokenExpired() {
    await this.notifyError(
      'token_expired',
      'Instagram access token has expired!',
      'Please re-authorize the app by visiting /auth/instagram/start'
    );
  }

  async notifyTokenRefreshFailed(errorDetail) {
    await this.notifyError(
      'token_refresh_failed',
      'Failed to automatically refresh Instagram token',
      errorDetail
    );
  }

  async notifyMessageSendFailed(userId, errorDetail) {
    await this.notifyError(
      'send_message_failed',
      `Could not send message to user ${userId}`,
      errorDetail
    );
  }

  async notifyBotStarted(hasValidToken) {
    if (!this.isConfigured()) return;

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    if (hasValidToken) {
      const message = `✅ <b>Bot Started</b>

🤖 CookNest Instagram Responder is now running

✓ Instagram token validated
✓ Ready to process messages

🕐 ${timestamp}`;
      
      await this.sendMessage(message);
    } else {
      const oauthUrl = process.env.IG_REDIRECT_URI 
        ? process.env.IG_REDIRECT_URI.replace('/auth/instagram/callback', '/auth/instagram/start')
        : 'https://carlotes.ganxo.net/auth/instagram/start';
      
      const message = `⚠️ <b>Bot Started - Authorization Needed</b>

🤖 CookNest Instagram Responder is running

❌ No valid Instagram token found

🔐 Please authorize the app:
<a href="${oauthUrl}">${oauthUrl}</a>

🕐 ${timestamp}`;
      
      await this.sendMessage(message);
    }
  }
}

const telegramNotifier = new TelegramNotifier();

module.exports = { telegramNotifier };
