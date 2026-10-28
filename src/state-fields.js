// Per-user state fields persisted for decide(). Shared fields are facts about the
// person (same in live and shadow mode); per-mode fields are the bot's own reply
// history, kept apart so shadow decisions never count as replies really sent.

const SHARED_FIELDS = {
  lang: "lang",
  lastFreeTextAt: "last_free_text_at",
  lastHumanAt: "last_human_at",
};

const MODE_FIELDS = {
  level: "level",
  level1SentAt: "level1_sent_at",
  lastReplyAt: "last_reply_at",
  lastRecipeAt: "last_recipe_at",
  lastLevel1Variant: "last_level1_variant",
  lastLevel2Variant: "last_level2_variant",
  lastEscalationNotifyAt: "last_escalation_notify_at",
};

const RECIPE_COUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECIPE_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

function splitUpdate(update) {
  const shared = {};
  const perMode = {};
  for (const [key, value] of Object.entries(update || {})) {
    if (key in SHARED_FIELDS) shared[key] = value;
    else if (key in MODE_FIELDS) perMode[key] = value;
  }
  return { shared, perMode };
}

module.exports = { SHARED_FIELDS, MODE_FIELDS, RECIPE_COUNT_WINDOW_MS, RECIPE_RETENTION_MS, splitUpdate };
