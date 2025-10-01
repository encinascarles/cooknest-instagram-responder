const axios = require("axios");
const { userDb } = require("./database");

async function getInstagramToken() {
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID || "";
  if (!instagramAccountId) {
    throw new Error(
      "INSTAGRAM_ACCOUNT_ID (business IG user ID) is not configured",
    );
  }

  const record = await userDb.getInstagramAccount(instagramAccountId);
  if (!record || !record.access_token) {
    throw new Error("No stored Instagram access token. Complete OAuth first.");
  }

  return { igUserId: instagramAccountId, accessToken: record.access_token };
}

async function sendTextMessage(psid, text) {
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
}

module.exports = { sendTextMessage };
