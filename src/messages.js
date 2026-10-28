// Every text the bot sends to Instagram users lives in this file, so they can be
// reviewed and edited in one place. Rules: 1-2 sentences, at most 1-2 emojis,
// Cooky 🐥 at most once, no ⚠️, no "por aquí no", no em dashes, Spanish says
// "recetario" (never "libro de recetas"). Quick reply titles: 20 chars max.

const LANGUAGES = ["es", "ca", "en"];
const DEFAULT_LANGUAGE = "es";

const TUTORIAL_URL = "https://cooknest.app/tutorial";
const APP_URL = "https://cooknest.app";
const TUTORIAL_VIDEO_PATH = "/media/tutorial-import-es.mp4"; // Spanish video, used for every language

// Quick reply payloads arrive back as "<KEY>|<lang>" in message.quick_reply.payload
const QUICK_REPLY_KEYS = ["WORKS", "NO_ICON", "NO_APP"];

const QUICK_REPLY_TITLES = {
  es: { WORKS: "Ya me sale ✅", NO_ICON: "No me sale CookNest", NO_APP: "No tengo la app" },
  ca: { WORKS: "Ja em surt ✅", NO_ICON: "No em surt CookNest", NO_APP: "No tinc l'app" },
  en: { WORKS: "Got it ✅", NO_ICON: "Can't find CookNest", NO_APP: "I don't have the app" },
};

const GREETINGS = {
  es: (name) => (name ? `¡Hola, ${name}!` : "¡Hola!"),
  ca: (name) => (name ? `Hola, ${name}!` : "Hola!"),
  en: (name) => (name ? `Hi ${name}!` : "Hi!"),
};

// Level 1: first reel (or first since this version). Sent right after the tutorial
// video, with the three quick replies attached.
const LEVEL1 = {
  es: [
    (hi) => `${hi} Parece que querías guardar esta receta en tu recetario 🐥 En el vídeo te enseño cómo hacerlo desde el reel en 20 segundos, ¿te sale?`,
    (hi) => `${hi} Esta receta ha llegado a nuestro chat y no a tu recetario, nos pasa a todos. En el vídeo lo ves: Compartir y luego CookNest, ¿te sale?`,
    (hi) => `${hi} Para que esta receta se quede en tu recetario, compártela desde el reel con la app CookNest 🐥 Te dejo un vídeo cortito de cómo se hace, ¿te sale?`,
    (hi) => `${hi} Qué buena pinta tiene esta receta. Se guarda en tu recetario compartiéndola con CookNest, te lo enseño en el vídeo, ¿te sale?`,
  ],
  ca: [
    (hi) => `${hi} Sembla que volies guardar aquesta recepta al teu receptari 🐥 Al vídeo t'ensenyo com fer-ho des del reel en 20 segons, et surt?`,
    (hi) => `${hi} Aquesta recepta ha arribat al nostre xat i no al teu receptari, ens passa a tots. Al vídeo ho veus: Comparteix i després CookNest, et surt?`,
    (hi) => `${hi} Perquè aquesta recepta es quedi al teu receptari, comparteix-la des del reel amb l'app CookNest 🐥 Et deixo un vídeo curtet de com es fa, et surt?`,
    (hi) => `${hi} Quina bona pinta té aquesta recepta. Es guarda al teu receptari compartint-la amb CookNest, t'ho ensenyo al vídeo, et surt?`,
  ],
  en: [
    (hi) => `${hi} Looks like you wanted to save this recipe to CookNest 🐥 The video shows how to do it from the reel in 20 seconds, does it work for you?`,
    (hi) => `${hi} This recipe landed in our chat instead of your CookNest recipes, it happens to all of us. The video shows how: Share, then CookNest. Does it work?`,
    (hi) => `${hi} To keep this recipe in CookNest, share it from the reel to the CookNest app 🐥 Here is a short video showing how, does it work for you?`,
    (hi) => `${hi} This recipe looks great. You save it to CookNest by sharing it to the app, the video shows how. Does it work for you?`,
  ],
};

// Level 2: the next reel within 30 days. One short line, rotated per person.
const LEVEL2 = {
  es: [
    "Esta también se guarda sola: toca Compartir en el reel y elige CookNest 🐥",
    "¡Buena elección! Compártela con CookNest desde el reel y la tendrás en tu recetario.",
    "Esta receta irá directa a tu recetario si la compartes con CookNest en lugar de enviárnosla.",
    "Si no ves CookNest al compartir, desliza la fila de apps hasta «Más» y actívala 🐥",
  ],
  ca: [
    "Aquesta també es guarda sola: toca Comparteix al reel i tria CookNest 🐥",
    "Bona tria! Comparteix-la amb CookNest des del reel i la tindràs al teu receptari.",
    "Aquesta recepta anirà directa al teu receptari si la comparteixes amb CookNest en lloc d'enviar-nos-la.",
    "Si no veus CookNest en compartir, llisca la fila d'apps fins a «Més» i activa-la 🐥",
  ],
  en: [
    "This one saves itself too: tap Share on the reel and pick CookNest 🐥",
    "Great pick! Share it to CookNest from the reel and it will be with your recipes.",
    "This recipe goes straight to CookNest if you share it to the app instead of sending it to us.",
    "If CookNest doesn't show up when sharing, scroll the app row to \"More\" and turn it on 🐥",
  ],
};

// Answers to the quick replies
const ANSWERS = {
  WORKS: {
    es: [
      "¡Genial! Ya tienes tu recetario en marcha 🐥",
      "¡Qué bien! A partir de ahora cada receta que compartas irá directa a tu recetario.",
      "¡Perfecto! Que lo disfrutes cocinando.",
    ],
    ca: [
      "Genial! Ja tens el teu receptari en marxa 🐥",
      "Que bé! A partir d'ara cada recepta que comparteixis anirà directa al teu receptari.",
      "Perfecte! Que ho gaudeixis cuinant.",
    ],
    en: [
      "Great! Your CookNest recipes are on their way 🐥",
      "Nice! From now on every recipe you share goes straight to CookNest.",
      "Perfect! Enjoy cooking.",
    ],
  },
  NO_ICON: {
    es: [
      `A veces CookNest se esconde: en Compartir, desliza la fila de apps hasta «Más» y activa CookNest o márcala como favorita. Aquí lo tienes paso a paso, y si sigue sin salir te escribo yo: ${TUTORIAL_URL}`,
      `Nos pasa a todos 🐥 Toca Compartir, desliza la fila de apps hasta el final, entra en «Más» y activa CookNest. Paso a paso aquí, y si no te sale te escribo yo: ${TUTORIAL_URL}`,
      `Es un momento: en Compartir, desliza las apps hasta «Más» y añade CookNest a favoritas para tenerla siempre a mano. Te lo enseño aquí, y si no te sale te escribo yo: ${TUTORIAL_URL}`,
    ],
    ca: [
      `De vegades CookNest s'amaga: a Comparteix, llisca la fila d'apps fins a «Més» i activa CookNest o marca-la com a preferida. Aquí ho tens pas a pas, i si encara no et surt t'escric jo: ${TUTORIAL_URL}`,
      `Ens passa a tots 🐥 Toca Comparteix, llisca la fila d'apps fins al final, entra a «Més» i activa CookNest. Pas a pas aquí, i si no et surt t'escric jo: ${TUTORIAL_URL}`,
      `És un moment: a Comparteix, llisca les apps fins a «Més» i afegeix CookNest a preferides per tenir-la sempre a mà. T'ho ensenyo aquí, i si no et surt t'escric jo: ${TUTORIAL_URL}`,
    ],
    en: [
      `Sometimes CookNest hides: in Share, scroll the app row to "More" and turn on CookNest or add it to your favorites. Step by step here, and if it still doesn't show up I'll write to you: ${TUTORIAL_URL}`,
      `It happens to all of us 🐥 Tap Share, scroll the app row to the end, open "More" and turn on CookNest. Step by step here, and if it doesn't work I'll write to you: ${TUTORIAL_URL}`,
      `It takes a second: in Share, scroll the apps to "More" and add CookNest to your favorites so it is always at hand. I show you here, and if it doesn't work I'll write to you: ${TUTORIAL_URL}`,
    ],
  },
  NO_APP: {
    es: [
      `CookNest guarda en tu recetario las recetas que ves en Instagram o TikTok, con sus ingredientes y pasos. Si te apetece probarla: ${APP_URL}`,
      `Con CookNest los reels de recetas se convierten en recetas de verdad, todas juntas en tu recetario. Está aquí, sin compromiso: ${APP_URL}`,
      `CookNest es la app para no perder más recetas entre capturas y guardados: todas en tu recetario, listas para cocinar. La tienes aquí: ${APP_URL}`,
    ],
    ca: [
      `CookNest guarda al teu receptari les receptes que veus a Instagram o TikTok, amb els ingredients i els passos. Si et ve de gust provar-la: ${APP_URL}`,
      `Amb CookNest els reels de receptes es converteixen en receptes de veritat, totes juntes al teu receptari. La tens aquí, sense compromís: ${APP_URL}`,
      `CookNest és l'app per no perdre més receptes entre captures i desats: totes al teu receptari, a punt per cuinar. La tens aquí: ${APP_URL}`,
    ],
    en: [
      `CookNest saves the recipes you see on Instagram or TikTok, with their ingredients and steps, all in one place. If you'd like to try it: ${APP_URL}`,
      `With CookNest, recipe reels become real recipes you can cook from, all together. Here it is, no pressure: ${APP_URL}`,
      `CookNest is the app to stop losing recipes among screenshots and saved posts. You can get it here: ${APP_URL}`,
    ],
  },
};

function normalizeLanguage(lang) {
  return LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

function variantCount(kind, lang) {
  return getVariants(kind, normalizeLanguage(lang)).length;
}

function getVariants(kind, lang) {
  if (kind === "level1") return LEVEL1[lang];
  if (kind === "level2") return LEVEL2[lang];
  if (ANSWERS[kind]) return ANSWERS[kind][lang];
  throw new Error(`Unknown message kind: ${kind}`);
}

function quickReplies(lang) {
  const titles = QUICK_REPLY_TITLES[normalizeLanguage(lang)];
  return QUICK_REPLY_KEYS.map((key) => ({
    title: titles[key],
    payload: `${key}|${normalizeLanguage(lang)}`,
  }));
}

/**
 * Builds the Instagram messages for one reply, in sending order.
 * @param {string} kind level1 | level2 | WORKS | NO_ICON | NO_APP
 * @param {{lang?: string, variant?: number, firstName?: string|null, publicBaseUrl?: string}} options
 * @returns {Array<{text?: string, quickReplies?: Array<{title:string,payload:string}>, video?: string}>}
 */
function buildMessages(kind, { lang, variant = 0, firstName = null, publicBaseUrl = "" } = {}) {
  const language = normalizeLanguage(lang);
  const variants = getVariants(kind, language);
  const template = variants[variant % variants.length];

  if (kind === "level1") {
    const messages = [];
    if (publicBaseUrl) {
      messages.push({ video: publicBaseUrl.replace(/\/+$/, "") + TUTORIAL_VIDEO_PATH });
    }
    messages.push({ text: template(GREETINGS[language](firstName)), quickReplies: quickReplies(language) });
    return messages;
  }
  return [{ text: template }];
}

/**
 * Parses a quick reply payload ("NO_ICON|ca").
 * @returns {{key: string, lang: string}|null}
 */
function parseQuickReplyPayload(payload) {
  if (typeof payload !== "string") return null;
  const [key, lang] = payload.split("|");
  if (!QUICK_REPLY_KEYS.includes(key)) return null;
  return { key, lang: normalizeLanguage(lang) };
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  TUTORIAL_URL,
  APP_URL,
  TUTORIAL_VIDEO_PATH,
  QUICK_REPLY_KEYS,
  QUICK_REPLY_TITLES,
  GREETINGS,
  LEVEL1,
  LEVEL2,
  ANSWERS,
  buildMessages,
  quickReplies,
  parseQuickReplyPayload,
  variantCount,
  normalizeLanguage,
};
