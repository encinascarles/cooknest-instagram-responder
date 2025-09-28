function getConfig() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const verifyToken = process.env.VERIFY_TOKEN || "";
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN || "";
  const graphApiVersion = process.env.GRAPH_API_VERSION || "v21.0";
  const autoReplyText =
    process.env.IG_REPLY_MESSAGE ||
    "Hola! Para importar recetas a CookNest, usa Compartir → CookNest en Instagram. Enviar el Reel por DM no importa la receta en la app. ¡Gracias!";

  return {
    port,
    verifyToken,
    pageAccessToken,
    graphApiVersion,
    autoReplyText,
  };
}

module.exports = { getConfig };
