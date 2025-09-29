const axios = require("axios");
const { getConfig } = require("./config");

async function sendTextMessage(psid, text) {
  const { pageAccessToken, graphApiVersion } = getConfig();


  if (!pageAccessToken) {
    throw new Error("PAGE_ACCESS_TOKEN is not set");
  }

  const content = {
    "recipient": { "id": psid },
    "message": { "text": text }
  };
  
  const url = `https://graph.facebook.com/${graphApiVersion}/me/messages?access_token=${pageAccessToken}`;

  const response = await axios.post(url, content);
  return response.data;
}

module.exports = { sendTextMessage };