const test = require("node:test");
const assert = require("node:assert/strict");
const { initLanguageDetector, detectLanguage } = require("../src/language");

test.before(() => initLanguageDetector());

test("detects Spanish, including the real lost replies", () => {
  for (const text of ["No se llegar", "Cómo encuentro lo de compartir", "No sé cómo compartir en la app", "Pues así lo he hecho no?", "Hola tenía una duda"]) {
    assert.equal(detectLanguage(text), "es", text);
  }
});

test("detects Catalan", () => {
  for (const text of ["He passat aquesta per si teniu controlada aquesta cuinera", "Bon dia, tinc un dubte", "No em surt CookNest, com ho faig?", "Moltes gràcies per tot"]) {
    assert.equal(detectLanguage(text), "ca", text);
  }
});

test("detects English", () => {
  for (const text of ["How do I save this recipe?", "Hi! I'd love to be a Cooknest ambassador", "Thanks a lot!"]) {
    assert.equal(detectLanguage(text), "en", text);
  }
});

test("no answer for too little text (caller keeps the previous language or Spanish)", () => {
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("Ok"), null);
  assert.equal(detectLanguage("👏"), null);
  assert.equal(detectLanguage("https://youtube.com/shorts/abc"), null);
});
