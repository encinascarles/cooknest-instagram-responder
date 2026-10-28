const axios = require("axios");
const { userDb } = require("./database");
const { describeError } = require("./logger");
const { telegramNotifier } = require("./telegram");

async function getInstagramToken() {
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID || "";
  if (!instagramAccountId) {
    const error = new Error("INSTAGRAM_ACCOUNT_ID (business IG user ID) is not configured");
    await telegramNotifier.notifyError('api_error', error.message, 'Check .env configuration');
    throw error;
  }

  const tokenRecord = await userDb.getInstagramToken();
  if (!tokenRecord || !tokenRecord.access_token) {
    const error = new Error("No stored Instagram access token. Complete OAuth first.");
    await telegramNotifier.notifyTokenExpired();
    throw error;
  }

  // Check if token is expired
  if (tokenRecord.expires_at) {
    const expiresAt = new Date(tokenRecord.expires_at);
    const now = new Date();
    if (expiresAt <= now) {
      const error = new Error("Instagram token has expired");
      await telegramNotifier.notifyTokenExpired();
      throw error;
    }
  }

  return { igUserId: instagramAccountId, accessToken: tokenRecord.access_token };
}

const GRAPH_VERSION = "v20.0";

// Converts an engine message ({text, quickReplies} or {video}) to the Instagram
// Messaging API shape (Instagram API with Instagram Login).
function toInstagramMessage(message) {
  if (message.video) {
    return { attachment: { type: "video", payload: { url: message.video } } };
  }
  const payload = { text: message.text };
  if (Array.isArray(message.quickReplies) && message.quickReplies.length > 0) {
    payload.quick_replies = message.quickReplies.map(({ title, payload: postback }) => ({
      content_type: "text",
      title,
      payload: postback,
    }));
  }
  return payload;
}

/**
 * Sends one message and returns the API response ({recipient_id, message_id}).
 * @param {string} psid Instagram-scoped id of the recipient
 * @param {{text?: string, quickReplies?: Array, video?: string}} message
 */
async function sendMessage(psid, message) {
  try {
    const { igUserId, accessToken } = await getInstagramToken();

    const payload = {
      recipient: { id: psid },
      message: toInstagramMessage(message),
    };
    console.log("sendMessage payload", JSON.stringify(payload));
    const url = `https://graph.instagram.com/${GRAPH_VERSION}/${igUserId}/messages?access_token=${accessToken}`;

    const response = await axios.post(url, payload, { timeout: 30000 });

    console.log("sendMessage response", response.data);
    return response.data;
  } catch (error) {
    // Extract error details
    const errorDetail = error?.response?.data?.error?.message || describeError(error) || "Unknown error";
    const errorCode = error?.response?.data?.error?.code;
    
    // Check if it's a token-related error
    if (errorCode === 190 || errorDetail.toLowerCase().includes('token') || errorDetail.toLowerCase().includes('oauth')) {
      await telegramNotifier.notifyTokenExpired();
    } else {
      // General send error
      await telegramNotifier.notifyMessageSendFailed(psid, errorDetail);
    }
    
    // Re-throw the error so the calling code can handle it
    throw error;
  }
}

async function sendTextMessage(psid, text) {
  return sendMessage(psid, { text });
}

module.exports = { sendMessage, sendTextMessage, toInstagramMessage, GRAPH_VERSION };
