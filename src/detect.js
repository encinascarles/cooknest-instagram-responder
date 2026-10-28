// Classifies incoming Instagram messages. Only what really looks like a recipe sent
// to our DM by mistake counts as "recipe": native shared reels/posts and
// instagram.com/reel|p links, plus TikTok videos / YouTube Shorts links when the
// message has nothing else besides the link.

// Regex to match URLs (http, https, and common shortened formats)
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
// Links pasted without scheme, only for the platforms we care about
const BARE_LINK_REGEX = /(?<![\w./])(?:(?:www|m|vm|vt)\.)?(?:instagram\.com|tiktok\.com|youtube\.com)\/[^\s<>"{}|\\^`\[\]]*/gi;

// Attachment types that are always a shared reel/post
const SHARE_ATTACHMENT_TYPES = ["ig_reel", "reel", "ig_post", "share"];
// Attachment types that are a share only when they carry shared media
const MAYBE_SHARE_ATTACHMENT_TYPES = ["story", "ig_story", "template"];
// A voice note is someone talking to us, like free text
const CONVERSATION_ATTACHMENT_TYPES = ["audio"];

// An instagram.com link may come with a short caption ("mira esta 😍"); a longer
// text is a conversation (UGC pitches with a portfolio link, questions...).
const MAX_CAPTION_LENGTH = 40;

/**
 * Parses the EXCLUDED_SENTENCES env var (pipe-separated list)
 * @returns {string[]} Array of excluded sentences (lowercased for comparison)
 */
function getExcludedSentences() {
  const envValue = process.env.EXCLUDED_SENTENCES || "";
  if (!envValue.trim()) return [];
  return envValue
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Checks if a message should be excluded (spam filter)
 * @param {string} text - The message text to check
 * @returns {boolean} True if message should be excluded
 */
function isExcludedMessage(text) {
  if (!text) return false;
  const excluded = getExcludedSentences();
  if (excluded.length === 0) return false;

  const lowerText = text.toLowerCase();
  return excluded.some((sentence) => lowerText.includes(sentence));
}

/**
 * Extracts all URLs from a message text (with scheme, or bare instagram/tiktok/youtube links)
 * @param {string} text - The message text to scan
 * @returns {string[]} Array of found URLs
 */
function extractUrls(text) {
  if (!text) return [];
  const withScheme = text.match(URL_REGEX) || [];
  const withoutScheme = text.replace(URL_REGEX, " ").match(BARE_LINK_REGEX) || [];
  return [...withScheme, ...withoutScheme];
}

function textWithoutUrls(text) {
  if (!text) return "";
  return text.replace(URL_REGEX, " ").replace(BARE_LINK_REGEX, " ").replace(/\s+/g, " ").trim();
}

function parseUrl(raw) {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_e) {
    return null;
  }
}

/**
 * Tells which recipe platform a link belongs to, or null if it is not a recipe link.
 * @returns {"instagram"|"tiktok"|"youtube_shorts"|null}
 */
function recipeLinkPlatform(raw) {
  const url = parseUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = url.pathname;

  if (host === "instagram.com" && /^\/(reel|reels|p)\/[\w-]+/i.test(path)) return "instagram";
  if ((host === "vm.tiktok.com" || host === "vt.tiktok.com") && path.length > 1) return "tiktok";
  if (host === "tiktok.com" && (/^\/@[^/]+\/video\/\d+/.test(path) || /^\/t\/\w+/.test(path))) return "tiktok";
  if (host === "youtube.com" && /^\/shorts\/[\w-]+/.test(path)) return "youtube_shorts";
  return null;
}

function isMediaShareAttachment(attachment, message) {
  const type = attachment?.type || "";
  if (SHARE_ATTACHMENT_TYPES.includes(type)) return true;
  if (!MAYBE_SHARE_ATTACHMENT_TYPES.includes(type)) return false;
  // A reply to one of our stories is a conversation, not a share
  if (message?.reply_to?.story) return false;
  const payload = attachment.payload || {};
  return Boolean(payload.url || payload.generic?.elements?.length || payload.elements?.length);
}

/**
 * Classifies an Instagram webhook `message` object.
 * @returns {{kind: "quick_reply", payload: string, text: string}
 *   | {kind: "recipe", source: "share"|"link", platform: string, text: string}
 *   | {kind: "text", text: string}
 *   | {kind: "other", text: string}}
 */
function classifyMessage(message) {
  const text = message?.text || "";
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  if (message?.quick_reply?.payload) {
    return { kind: "quick_reply", payload: message.quick_reply.payload, text };
  }

  const caption = textWithoutUrls(text);

  if (attachments.some((att) => isMediaShareAttachment(att, message))) {
    if (caption.length > MAX_CAPTION_LENGTH) return { kind: "text", text };
    return { kind: "recipe", source: "share", platform: "instagram", text };
  }

  const platforms = extractUrls(text).map(recipeLinkPlatform);
  if (platforms.length > 0) {
    const allRecipeLinks = platforms.every(Boolean);
    if (allRecipeLinks && platforms.includes("instagram") && caption.length <= MAX_CAPTION_LENGTH) {
      return { kind: "recipe", source: "link", platform: "instagram", text };
    }
    if (allRecipeLinks && caption === "") {
      return { kind: "recipe", source: "link", platform: platforms[0], text };
    }
    // Any other link: someone talking to us if there is text around it, else just a link
    return caption ? { kind: "text", text } : { kind: "other", text };
  }

  if (text.trim()) return { kind: "text", text };
  if (attachments.some((att) => CONVERSATION_ATTACHMENT_TYPES.includes(att?.type))) {
    return { kind: "text", text };
  }
  return { kind: "other", text };
}

// Previous detection, still used by the webhook until it moves to the reply engine
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

/**
 * Checks if a message contains any shared URLs
 * @param {{ text: string, attachments: Array }} message
 * @returns {boolean}
 */
function hasSharedUrls({ text, attachments }) {
  // Check text for URLs
  if (text && URL_REGEX.test(text)) {
    // Reset regex lastIndex since we use 'g' flag
    URL_REGEX.lastIndex = 0;
    return true;
  }

  // Check attachments for URL types
  for (const att of attachments || []) {
    const type = att?.type || "";
    if (type === "share" && att?.url) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isInstagramMediaMessage,
  hasSharedUrls,
  classifyMessage,
  recipeLinkPlatform,
  extractUrls,
  textWithoutUrls,
  isExcludedMessage,
  MAX_CAPTION_LENGTH,
};
