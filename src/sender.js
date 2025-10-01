const axios = require("axios");
const { userDb } = require("./database");
const { logger } = require("./logger");
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

async function sendTextMessage(psid, text) {
  try {
    const { igUserId, accessToken } = await getInstagramToken();

    const payload = {
      recipient: { id: psid },
      message: { text },
    };
    console.log("sendTextMessage payload", payload);
    const url = `https://graph.instagram.com/v20.0/${igUserId}/messages?access_token=${accessToken}`;

    const response = await axios.post(url, payload);

    console.log("sendTextMessage response", response.data);
    return response.data;
  } catch (error) {
    // Extract error details
    const errorDetail = error?.response?.data?.error?.message || error?.message || "Unknown error";
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

module.exports = { sendTextMessage };
