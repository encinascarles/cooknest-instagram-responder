// Language detection for the user's own text (ES, CA, EN), with the eld library
// (n-gram detector; franc mixes up short Spanish and Catalan sentences).
// Returns null when there is no reliable answer, so the caller keeps the
// previous language or falls back to Spanish.

const { textWithoutUrls } = require("./detect");

const SUPPORTED = ["es", "ca", "en"];
const MIN_LETTERS = 3;

let detector = null;
let loading = null;

function initLanguageDetector() {
  if (!loading) {
    loading = import("eld").then(async ({ eld }) => {
      await eld.load("medium");
      eld.setLanguageSubset(SUPPORTED);
      detector = eld;
    });
  }
  return loading;
}

/**
 * @param {string} text
 * @returns {"es"|"ca"|"en"|null}
 */
function detectLanguage(text) {
  if (!detector || !text) return null;
  const clean = textWithoutUrls(text);
  if (clean.replace(/[^\p{L}]/gu, "").length < MIN_LETTERS) return null;
  const result = detector.detect(clean);
  if (!result.isReliable()) return null;
  return SUPPORTED.includes(result.language) ? result.language : null;
}

module.exports = { initLanguageDetector, detectLanguage };
