#!/usr/bin/env node
// Writes every user-facing text from src/messages.js as a Markdown list to review.
// Usage: node scripts/export-messages.js <MESSAGES.md>

const fs = require("fs");
const m = require("../src/messages");

const out = process.argv[2];
if (!out) {
  console.error("Usage: node scripts/export-messages.js <MESSAGES.md>");
  process.exit(1);
}

const LANGUAGE_NAMES = { es: "Castellano", ca: "Català", en: "English" };
const lines = [];
const p = (line = "") => lines.push(line);

p("# Textos del bot de Instagram (para revisar)");
p();
p("Generado desde `src/messages.js` con `node scripts/export-messages.js`. Para cambiar un texto, edita ese archivo.");
p("Idioma: el del texto que la persona nos haya escrito (castellano, catalán o inglés); castellano si nunca ha escrito texto. El vídeo es en castellano para todos.");
p();
p("## Nivel 1: primer reel (vídeo tutorial + texto + 3 botones)");
p();
p("Orden: 1) el vídeo de 22 s, 2) uno de estos textos (se elige rotando por persona) con los botones debajo. Con nombre cuando el perfil tiene un nombre de pila reconocible, si no sin nombre.");
for (const lang of m.LANGUAGES) {
  p();
  p(`### ${LANGUAGE_NAMES[lang]}`);
  p();
  m.LEVEL1[lang].forEach((template, i) => {
    p(`${i + 1}. ${template(m.GREETINGS[lang]("Marta"))}`);
    p(`   - Sin nombre: ${template(m.GREETINGS[lang](null))}`);
  });
  p();
  p(`Botones: ${m.QUICK_REPLY_KEYS.map((k) => `«${m.QUICK_REPLY_TITLES[lang][k]}»`).join(", ")}`);
}
p();
p("## Nivel 2: siguiente reel en menos de 30 días (una línea, nunca la misma que la última vez)");
for (const lang of m.LANGUAGES) {
  p();
  p(`### ${LANGUAGE_NAMES[lang]}`);
  p();
  m.LEVEL2[lang].forEach((text, i) => p(`${i + 1}. ${text}`));
}
p();
p("## Nivel 3 y siguientes: silencio");
p();
p("No se envía nada a la persona. A Telegram, una vez al día como máximo: «<Nombre> (@usuario) te ha enviado N reels esta semana, escríbele tú», con el enlace al perfil.");

const ANSWER_TITLES = {
  WORKS: "Respuesta al botón «Ya me sale»",
  NO_ICON: "Respuesta al botón «No me sale CookNest» (además avisa a Telegram para que le escriba un humano)",
  NO_APP: "Respuesta al botón «No tengo la app»",
};
for (const key of m.QUICK_REPLY_KEYS) {
  p();
  p(`## ${ANSWER_TITLES[key]}`);
  for (const lang of m.LANGUAGES) {
    p();
    p(`### ${LANGUAGE_NAMES[lang]}`);
    p();
    m.ANSWERS[key][lang].forEach((text, i) => p(`${i + 1}. ${text}`));
  }
}
p();

fs.writeFileSync(out, lines.join("\n"));
console.log(`Written ${out}`);
