function getConfig() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const verifyToken = process.env.VERIFY_TOKEN || "";
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN_1 + process.env.PAGE_ACCESS_TOKEN_2 || "";
  const graphApiVersion = process.env.GRAPH_API_VERSION || "v20.0";
  const botId = process.env.INSTAGRAM_ACCOUNT_ID || "";
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID || "";
  const igAppId = process.env.IG_APP_ID || "";
  const igAppSecret = process.env.IG_APP_SECRET || "";
  const igRedirectUri = process.env.IG_REDIRECT_URI || "";
  const igLoginScopes =
    process.env.IG_LOGIN_SCOPES ||
    "instagram_basic,instagram_manage_messages,pages_show_list,pages_read_engagement,pages_manage_metadata";
  const firstTimeMessage =
    process.env.IG_FIRST_TIME_MESSAGE ||
    "¡Hola! 👋 Veo que es la primera vez que nos envías un reel. Para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest. Si no te aparece, te ayudo a configurarlo 😊";
  
  const returningUserMessage =
    process.env.IG_RETURNING_MESSAGE ||
    "¡Gracias por enviarnos otro reel! 🙌 Recuerda: para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest.";
  
  const enableAckMessage = process.env.ENABLE_ACK_MESSAGE === "true";
  const ackMessage = 
    process.env.ACK_MESSAGE ||
    "¡Gracias por contactarnos! 😊 Te responderemos en breve.";
  const ackWindowDays = process.env.ACK_WINDOW_DAYS !== undefined ? parseInt(process.env.ACK_WINDOW_DAYS) : 7;
  return {
    port,
    verifyToken,
    pageAccessToken,
    graphApiVersion,
    botId,
    instagramAccountId,
    igAppId,
    igAppSecret,
    igRedirectUri,
    igLoginScopes,
    firstTimeMessage,
    returningUserMessage,
    enableAckMessage,
    ackMessage,
    ackWindowDays,
  };
}

module.exports = { getConfig };
