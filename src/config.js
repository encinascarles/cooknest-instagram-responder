function getConfig() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const verifyToken = process.env.VERIFY_TOKEN || "";
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN_1 + process.env.PAGE_ACCESS_TOKEN_2 || "";
  const graphApiVersion = process.env.GRAPH_API_VERSION || "v20.0";
  const firstTimeMessage =
    process.env.IG_FIRST_TIME_MESSAGE ||
    "¡Hola! 👋 Veo que es la primera vez que nos envías un reel. Para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest. Si no te aparece, te ayudo a configurarlo 😊";
  
  const returningUserMessage =
    process.env.IG_RETURNING_MESSAGE ||
    "¡Gracias por enviarnos otro reel! 🙌 Recuerda: para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest.";

  console.log("Page Access Token length:", pageAccessToken.length);
  return {
    port,
    verifyToken,
    pageAccessToken,
    graphApiVersion,
    firstTimeMessage,
    returningUserMessage,
  };
}

module.exports = { getConfig };
