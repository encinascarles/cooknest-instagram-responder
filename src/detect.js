function isInstagramMediaMessage({ text, attachments }) {
  // Check if text contains Instagram URLs
  if (text && text.includes("instagram.com/")) {
    return true;
  }

  // Check attachments for Instagram media types
  for (const att of attachments || []) {
    const type = att?.type || "";
    if (["ig_reel", "reel", "share", "story", "template"].includes(type)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isInstagramMediaMessage,
};