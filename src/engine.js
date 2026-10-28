// The auto-reply decision, as a pure function: decide(state, event, now) -> action.
// No I/O here: the responder gathers the state, calls decide() and executes the
// action, so the same code runs in production, in the tests and in the log replay.

const { buildMessages, parseQuickReplyPayload, variantCount, normalizeLanguage, DEFAULT_LANGUAGE } = require("./messages");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULT_CONFIG = {
  humanWindowMs: 14 * DAY, // a human from our team wrote to them: stay out
  pendingTextWindowMs: 24 * HOUR, // they wrote free text nobody answered yet
  burstGapMs: 2 * MINUTE, // reels this close together belong to the same burst
  replyCooldownMs: 1 * HOUR, // our last reply is still on their screen
  levelResetMs: 30 * DAY, // after this long without reels, start again at level 2
  escalationNotifyEveryMs: 7 * DAY,
  creatorFollowerThreshold: 5000,
  publicBaseUrl: "",
};

// Why an automatic reply was not sent. Rules marked notify=true tell Telegram, as
// the old bot did for every non-reel message, so a human sees it.
const SILENCE_REASONS = {
  burst: { notify: false, label: "ráfaga de reels" },
  human_recent: { notify: true, label: "conversación con un humano (14 días)" },
  pending_human: { notify: true, label: "texto pendiente de respuesta (24 h)" },
  creator_followed: { notify: true, label: "le seguimos" },
  creator_verified: { notify: true, label: "cuenta verificada" },
  creator_followers: { notify: true, label: "creador (muchos seguidores)" },
  profile_unknown: { notify: true, label: "perfil no disponible (enlace)" },
  cooldown: { notify: false, label: "respuesta reciente (1 h)" },
  level3: { notify: false, label: "nivel 3 (ya avisado dos veces)" },
};

// Words that make a profile name look like a brand or a nickname, not a first name
const NOT_A_FIRST_NAME = new Set([
  "chef", "cocina", "cocinas", "cuina", "kitchen", "cooking", "cook", "food", "foodie", "receta", "recetas",
  "recepta", "receptes", "recipe", "recipes", "official", "oficial", "the", "la", "el", "los", "las", "les",
  "mr", "mrs", "ms", "sr", "sra", "team", "equipo", "shop", "store", "tienda", "botiga", "blog", "club",
  "bar", "restaurante", "restaurant", "cafe", "café", "studio", "estudio", "home", "casa", "mama", "mamá",
  "papa", "papá", "user", "usuario", "info", "hola", "hello", "hi",
]);

/**
 * Returns a first name to greet with, or null if the profile name does not look
 * like a real person's name.
 */
function firstNameFrom(profileName) {
  if (!profileName || typeof profileName !== "string") return null;
  const cleaned = profileName
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, " ")
    .trim();
  const token = cleaned.split(/\s+/)[0] || "";
  if (!/^\p{L}+(?:['’-]\p{L}+)?$/u.test(token)) return null;
  const letters = Array.from(token);
  if (letters.length < 2 || letters.length > 15) return null;
  if (NOT_A_FIRST_NAME.has(token.toLowerCase())) return null;
  // ALL CAPS ("FÉNIX") reads like a handle or a brand
  if (letters.length > 3 && token === token.toUpperCase()) return null;
  return letters[0].toUpperCase() + letters.slice(1).join("").toLowerCase();
}

function hashString(value) {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  }
  return hash;
}

// Rotates through the variants: never the same as the last one sent to this person
function nextVariant(lastVariant, count, seed) {
  if (lastVariant === null || lastVariant === undefined) return hashString(seed) % count;
  return (lastVariant + 1) % count;
}

function within(now, at, windowMs) {
  return typeof at === "number" && now - at < windowMs;
}

function silent(reason, update, extra = {}) {
  const rule = SILENCE_REASONS[reason];
  return {
    type: "silent",
    reason,
    kind: null,
    messages: [],
    notify: rule && rule.notify ? { type: "suppressed", reason, label: rule.label } : null,
    update,
    ...extra,
  };
}

function creatorReason(state, config) {
  const profile = state.profile;
  if (!profile) return null;
  if (profile.isBusinessFollowUser) return "creator_followed";
  if (profile.isVerifiedUser) return "creator_verified";
  if (typeof profile.followerCount === "number" && profile.followerCount >= config.creatorFollowerThreshold) {
    return "creator_followers";
  }
  return null;
}

function decideRecipe(state, event, now, config) {
  const eventAt = event.at ?? now;
  const lastAt = Math.max(event.lastAt ?? eventAt, eventAt);
  const previousRecipeAt = state.lastRecipeAt ?? null;
  const update = { lastRecipeAt: Math.max(previousRecipeAt ?? 0, lastAt) };

  // 1. Burst guard: reels within 2 minutes of the previous one get no new reply
  if (previousRecipeAt !== null && eventAt - previousRecipeAt < config.burstGapMs) {
    return silent("burst", update);
  }

  // 2. Never inside a conversation
  if (within(now, state.lastHumanAt, config.humanWindowMs)) {
    return silent("human_recent", update);
  }
  if (
    within(now, state.lastFreeTextAt, config.pendingTextWindowMs) &&
    !(typeof state.lastHumanAt === "number" && state.lastHumanAt >= state.lastFreeTextAt)
  ) {
    return silent("pending_human", update);
  }

  // 3. Creators and brands: profile fields from the Instagram User Profile API
  if (state.profileStatus === "failed" && event.source === "link") {
    return silent("profile_unknown", update);
  }
  const creator = creatorReason(state, config);
  if (creator) return silent(creator, update);

  // 4. Our previous reply is still fresh
  if (within(now, state.lastReplyAt, config.replyCooldownMs)) {
    return silent("cooldown", update);
  }

  // 5. Escalate instead of repeating
  const lang = normalizeLanguage(event.lang || state.lang || DEFAULT_LANGUAGE);
  if (event.lang) update.lang = event.lang;
  const cycleExpired = previousRecipeAt === null || eventAt - previousRecipeAt > config.levelResetMs;
  let level;
  if (!state.level1SentAt) level = 1;
  else if (cycleExpired) level = 2;
  else level = Math.min((state.level || 1) + 1, 3);

  if (level >= 3) {
    update.level = 3;
    const action = silent("level3", update);
    if (!within(now, state.lastEscalationNotifyAt, config.escalationNotifyEveryMs)) {
      update.lastEscalationNotifyAt = now;
      action.notify = { type: "escalation", reelsThisWeek: state.recipesLast7Days || 1 };
    }
    return action;
  }

  if (level === 1) {
    const variant = nextVariant(state.lastLevel1Variant, variantCount("level1", lang), state.userId);
    const firstName = firstNameFrom(state.profile && state.profile.name);
    return {
      type: "reply",
      kind: "level1",
      reason: null,
      lang,
      variant,
      messages: buildMessages("level1", { lang, variant, firstName, publicBaseUrl: config.publicBaseUrl }),
      notify: null,
      update: { ...update, level: 1, level1SentAt: now, lastReplyAt: now, lastLevel1Variant: variant },
    };
  }

  const variant = nextVariant(state.lastLevel2Variant, variantCount("level2", lang), `${state.userId}:2`);
  return {
    type: "reply",
    kind: "level2",
    reason: null,
    lang,
    variant,
    messages: buildMessages("level2", { lang, variant }),
    notify: null,
    update: { ...update, level: 2, lastReplyAt: now, lastLevel2Variant: variant },
  };
}

function decideQuickReply(state, event, now, config) {
  const parsed = parseQuickReplyPayload(event.payload);
  if (!parsed) {
    // Not one of ours: treat it like any other message
    return { type: "none", reason: "unknown_quick_reply", kind: null, messages: [], notify: { type: "message" }, update: {} };
  }
  // A human took over after our prompt: let them handle it
  if (typeof state.lastHumanAt === "number" && state.lastHumanAt > (state.lastReplyAt ?? 0) && within(now, state.lastHumanAt, config.humanWindowMs)) {
    return { ...silent("human_recent", {}), notify: { type: "message" } };
  }
  const { key, lang } = parsed;
  const variant = hashString(`${state.userId}:${key}`) % variantCount(key, lang);
  return {
    type: "reply",
    kind: key,
    reason: null,
    lang,
    variant,
    messages: buildMessages(key, { lang, variant }),
    notify: key === "NO_ICON" ? { type: "needs_help" } : null,
    update: { lang },
  };
}

/**
 * Decides what to do with one inbound event.
 *
 * @param {object} state per-user state (see README "Decision engine"):
 *   userId, lang, lastHumanAt, lastFreeTextAt, profile {name, username, followerCount,
 *   isBusinessFollowUser, isVerifiedUser}, profileStatus ("ok"|"failed"|"unknown"),
 *   level, level1SentAt, lastReplyAt, lastRecipeAt, lastLevel1Variant, lastLevel2Variant,
 *   lastEscalationNotifyAt, recipesLast7Days. Times are epoch milliseconds.
 * @param {object} event {type: "recipe", source: "share"|"link", at, lastAt?, count?, lang?}
 *   | {type: "quick_reply", payload, at} | {type: "text", text, lang?, at} | {type: "other", at}
 * @param {number} now epoch milliseconds
 * @param {object} [config] overrides of DEFAULT_CONFIG
 * @returns {{type: "reply"|"silent"|"none", kind: string|null, reason: string|null,
 *   messages: Array, notify: object|null, update: object, lang?: string, variant?: number}}
 */
function decide(state, event, now, config = {}) {
  const settings = { ...DEFAULT_CONFIG, ...config };
  switch (event.type) {
    case "recipe":
      return decideRecipe(state, event, now, settings);
    case "quick_reply":
      return decideQuickReply(state, event, now, settings);
    case "text": {
      const update = { lastFreeTextAt: event.at ?? now };
      if (event.lang) update.lang = event.lang;
      return { type: "none", reason: "free_text", kind: null, messages: [], notify: { type: "message" }, update };
    }
    default:
      return { type: "none", reason: "not_recipe", kind: null, messages: [], notify: { type: "message" }, update: {} };
  }
}

/**
 * An echo is a message sent from our account. It is the bot's own message only
 * when its mid is one the send API returned to us; anything else is a human.
 */
function classifyEcho(mid, isOurMid) {
  return mid && isOurMid ? "bot" : "human";
}

module.exports = {
  decide,
  classifyEcho,
  firstNameFrom,
  nextVariant,
  DEFAULT_CONFIG,
  SILENCE_REASONS,
  MINUTE,
  HOUR,
  DAY,
};
