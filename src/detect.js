// Regex to match URLs (http, https, and common shortened formats)
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

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
 * Extracts all URLs from a message text
 * @param {string} text - The message text to scan
 * @returns {string[]} Array of found URLs
 */
function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(URL_REGEX);
  return matches || [];
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
  extractUrls,
  hasSharedUrls,
  isExcludedMessage,
};
