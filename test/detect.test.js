const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMessage, recipeLinkPlatform } = require("../src/detect");

const kind = (message) => classifyMessage(message).kind;

test("native shared reels and posts are recipes", () => {
  for (const type of ["ig_reel", "reel", "ig_post", "share"]) {
    assert.deepEqual(
      { kind: kind({ attachments: [{ type, payload: { url: "https://x" } }] }) },
      { kind: "recipe" },
      type
    );
  }
});

test("story/template count only when they carry shared media", () => {
  assert.equal(kind({ attachments: [{ type: "story", payload: { url: "https://x" } }] }), "recipe");
  assert.equal(kind({ attachments: [{ type: "template", payload: { generic: { elements: [{ title: "t" }] } } }] }), "recipe");
  assert.equal(kind({ attachments: [{ type: "template", payload: {} }] }), "other");
  assert.equal(kind({ attachments: [{ type: "story_mention", payload: { url: "https://x" } }] }), "other");
  // Reply to one of our stories: a conversation
  assert.equal(
    kind({ text: "", reply_to: { story: { id: "1", url: "https://x" } }, attachments: [{ type: "story", payload: { url: "https://x" } }] }),
    "other"
  );
});

test("own photos and stickers are not recipes, voice notes are conversation", () => {
  assert.equal(kind({ attachments: [{ type: "image", payload: { url: "https://x" } }] }), "other");
  assert.equal(kind({ attachments: [{ type: "audio", payload: { url: "https://x" } }] }), "text");
});

test("instagram reel/p links are recipes, with at most a short caption", () => {
  assert.equal(kind({ text: "https://www.instagram.com/reel/DTgBq4QDMNh/?igsh=MThzMWV2aml" }), "recipe");
  assert.equal(kind({ text: "https://www.instagram.com/p/DTaWBDWgH8i/" }), "recipe");
  assert.equal(kind({ text: "mira esta 😍 instagram.com/reel/ABC123/" }), "recipe");
  assert.equal(kind({ text: "https://www.instagram.com/cooknest.app/" }), "other");
  // A UGC pitch with a portfolio link is a conversation
  assert.equal(
    kind({ text: "Hola equipo, soy Marina, creadora UGC especializada en recetas. Mi portfolio: https://www.instagram.com/p/ABC/" }),
    "text"
  );
});

test("TikTok videos and YouTube Shorts only when the message is just the link", () => {
  assert.equal(kind({ text: "https://vm.tiktok.com/ZMh7abc12/" }), "recipe");
  assert.equal(kind({ text: "https://www.tiktok.com/@cook/video/7312345678901234567?_r=1" }), "recipe");
  assert.equal(kind({ text: "https://youtube.com/shorts/0orBway4glo?si=WaVOUdYB38mVqNZS" }), "recipe");
  assert.equal(kind({ text: "esta receta https://youtube.com/shorts/0orBway4glo" }), "text");
  // Profile links sent by a creator negotiating: not a recipe
  assert.equal(kind({ text: "https://www.tiktok.com/@marlovesphotography?_r=1&_t=ZS-94sBC" }), "other");
  assert.equal(kind({ text: "https://youtube.com/watch?v=abc" }), "other");
});

test("any other URL or text gets no auto-reply", () => {
  assert.equal(kind({ text: "https://ln.run/insignia-personal-verificada2026" }), "other");
  assert.equal(kind({ text: "Tu cuenta es apta para la insignia: https://sw.run/abc" }), "text");
  assert.equal(kind({ text: "Como guardo la receta" }), "text");
});

test("quick replies are their own kind, not free text", () => {
  const result = classifyMessage({ text: "Ya me sale ✅", quick_reply: { payload: "WORKS|es" } });
  assert.equal(result.kind, "quick_reply");
  assert.equal(result.payload, "WORKS|es");
});

test("recipeLinkPlatform", () => {
  assert.equal(recipeLinkPlatform("instagram.com/reels/ABC/"), "instagram");
  assert.equal(recipeLinkPlatform("https://m.youtube.com/shorts/abc"), "youtube_shorts");
  assert.equal(recipeLinkPlatform("https://example.com/reel/abc"), null);
});
