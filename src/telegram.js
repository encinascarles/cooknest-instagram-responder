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
      logger.error('Failed to send Telegram notification', error);
    }
  }

  async notifyImportantMessage(userProfile, messageText) {
    if (!this.isConfigured()) return;

    // Check if message should be excluded (spam filter)
    if (isExcludedMessage(messageText)) {
      logger.log(`Message excluded by spam filter: "${logger.truncateMessage(messageText, 50)}"`);
      return;
    }

    await this.sendMessage(`${profileLink(userProfile)}: ${escapeHtml(truncate(messageText, 100))}`);
  }

  // A reel/link we did not answer because of a conversation or creator rule
  async notifyRecipeNotAnswered(userProfile, messageText, reasonLabel) {
    if (!this.isConfigured()) return;
    if (isExcludedMessage(messageText)) return;

    await this.sendMessage(
      `${profileLink(userProfile)}: ${escapeHtml(truncate(messageText, 100))}\n<i>Sin respuesta automática: ${escapeHtml(reasonLabel)}</i>`
    );
  }

  // Level 3+: the bot stays silent, a human should write to them
  async notifyRepeatedReels(userProfile, reelsThisWeek) {
    if (!this.isConfigured()) return;

    const reels = reelsThisWeek === 1 ? '1 reel' : `${reelsThisWeek} reels`;
    await this.sendMessage(`🔁 ${profileLink(userProfile)} te ha enviado ${reels} esta semana, escríbele tú`);
  }

  // Quick reply "No me sale CookNest": the bot explained, a human should follow up
  async notifyNeedsHelp(userProfile) {
    if (!this.isConfigured()) return;

    await this.sendMessage(`🆘 ${profileLink(userProfile)} no encuentra CookNest al compartir. Le he enviado el tutorial, escríbele tú si hace falta`);
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Cut by characters, not UTF-16 units: a split emoji makes Telegram reject the
// whole message ("text must be encoded in UTF-8")
function truncate(text, maxLength) {
  const chars = Array.from(text || '');
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '...' : chars.join('');
}

// "<b>Name</b> (@user)" linked to the Instagram profile when we know the username
function profileLink(userProfile) {
  const name = escapeHtml(userProfile?.name || userProfile?.full_name || 'Usuario desconocido');
  const username = userProfile?.username;
  if (!username) return `<b>${name}</b>`;
  return `<a href="https://instagram.com/${encodeURIComponent(username)}"><b>${name}</b> (@${escapeHtml(username)})</a>`;
}

const telegramNotifier = new TelegramNotifier();

module.exports = { telegramNotifier, TelegramNotifier, profileLink, truncate, escapeHtml };
