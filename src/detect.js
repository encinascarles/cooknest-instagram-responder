const INSTAGRAM_URL_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+/i;

function isInstagramUrl(text) {
  if (!text || typeof text !== "string") return false;
  return INSTAGRAM_URL_REGEX.test(text);
}

function isInstagramAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return false;
  const type = attachment.type || "";
  // Some IG DMs surface as type 'story', 'reel', 'share', or 'template' with payload containing IG URL
  if (["reel", "story", "share", "template"].includes(type)) {
    const payload = attachment.payload || {};
    const url = payload.url || payload.href || "";
    if (isInstagramUrl(url)) return true;
    // Some shares include a title or description with link text
    if (isInstagramUrl(payload.title) || isInstagramUrl(payload.description))
      return true;
    return type === "reel";
  }
  // Generic 'fallback' with URL
  const url = attachment?.payload?.url || attachment?.url || "";
  return isInstagramUrl(url);
}

function isInstagramMediaMessage({ text, attachments }) {
  if (isInstagramUrl(text)) return true;
  for (const att of attachments || []) {
    if (isInstagramAttachment(att)) return true;
    // Media with source domain instagram.com
    const domain = att?.payload?.source || att?.payload?.url || "";
    if (isInstagramUrl(domain)) return true;
  }
  return false;
}

module.exports = {
  isInstagramMediaMessage,
};
