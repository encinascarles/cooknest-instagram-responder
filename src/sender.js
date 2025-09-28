const axios = require("axios");
const { getConfig } = require("./config");

async function sendTextMessage(psid, text) {
  const { pageAccessToken, graphApiVersion } = getConfig();
  if (!pageAccessToken) {
    throw new Error("PAGE_ACCESS_TOKEN is not set");
  }

  const url = `https://graph.facebook.com/${graphApiVersion}/me/messages`;

  const payload = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text },
  };

  await axios.post(url, payload, {
    params: { access_token: pageAccessToken },
    timeout: 10000,
  });
}

module.exports = { sendTextMessage };
