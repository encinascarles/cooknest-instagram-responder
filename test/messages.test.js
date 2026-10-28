const test = require("node:test");
const assert = require("node:assert/strict");
const messages = require("../src/messages");

function allTexts() {
  const texts = [];
  for (const lang of messages.LANGUAGES) {
    for (const [i, template] of messages.LEVEL1[lang].entries()) {
      texts.push({ id: `level1.${lang}.${i}.name`, lang, text: template(messages.GREETINGS[lang]("Marta")) });
      texts.push({ id: `level1.${lang}.${i}`, lang, text: template(messages.GREETINGS[lang](null)) });
    }
    messages.LEVEL2[lang].forEach((text, i) => texts.push({ id: `level2.${lang}.${i}`, lang, text }));
    for (const key of messages.QUICK_REPLY_KEYS) {
      messages.ANSWERS[key][lang].forEach((text, i) => texts.push({ id: `${key}.${lang}.${i}`, lang, text }));
    }
  }
  return texts;
}

const emojis = (text) => text.match(/\p{Extended_Pictographic}/gu) || [];

test("3-4 variants per message and language", () => {
  for (const lang of messages.LANGUAGES) {
    for (const list of [messages.LEVEL1[lang], messages.LEVEL2[lang], ...messages.QUICK_REPLY_KEYS.map((k) => messages.ANSWERS[k][lang])]) {
      assert.ok(list.length >= 3 && list.length <= 4, `${lang}: ${list.length}`);
    }
  }
});

test("tone rules: no ⚠️, no scolding, no em dashes, 1-2 emojis, Cooky once", () => {
  for (const { id, text } of allTexts()) {
    assert.ok(!text.includes("⚠"), id);
    assert.ok(!/por aqu[ií] no/i.test(text), id);
    assert.ok(!text.includes("—") && !text.includes("–"), id);
    assert.ok(emojis(text).length <= 2, `${id}: ${emojis(text).join("")}`);
    assert.ok((text.match(/🐥/gu) || []).length <= 1, id);
  }
});

test("Spanish says recetario, never libro de recetas", () => {
  for (const { id, lang, text } of allTexts()) {
    assert.ok(!/libro de recetas/i.test(text), id);
    if (lang === "ca") assert.ok(!/llibre de receptes/i.test(text), id);
  }
});

test("quick reply titles fit in 20 characters", () => {
  for (const lang of messages.LANGUAGES) {
    for (const title of Object.values(messages.QUICK_REPLY_TITLES[lang])) {
      assert.ok(Array.from(title).length <= 20, `${lang}: ${title}`);
    }
  }
});

test("answers carry the right links", () => {
  for (const lang of messages.LANGUAGES) {
    for (const text of messages.ANSWERS.NO_ICON[lang]) assert.ok(text.includes(messages.TUTORIAL_URL), text);
    for (const text of messages.ANSWERS.NO_APP[lang]) assert.ok(text.includes(messages.APP_URL), text);
  }
});

test("level 1 = video first, then the text with quick replies", () => {
  const built = messages.buildMessages("level1", { lang: "en", variant: 1, firstName: "Sel", publicBaseUrl: "https://carlotes.ganxo.net/" });
  assert.deepEqual(built[0], { video: "https://carlotes.ganxo.net/media/tutorial-import-es.mp4" });
  assert.match(built[1].text, /^Hi Sel!/);
  assert.deepEqual(built[1].quickReplies.map((q) => q.payload), ["WORKS|en", "NO_ICON|en", "NO_APP|en"]);
});

test("quick reply payload parsing", () => {
  assert.deepEqual(messages.parseQuickReplyPayload("NO_APP|ca"), { key: "NO_APP", lang: "ca" });
  assert.deepEqual(messages.parseQuickReplyPayload("WORKS|xx"), { key: "WORKS", lang: "es" });
  assert.equal(messages.parseQuickReplyPayload("SOMETHING"), null);
});
