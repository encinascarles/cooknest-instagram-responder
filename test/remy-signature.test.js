const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { sign, signedHeaders, verify } = require("../src/remy-signature");

const SECRET = "test-secret";
const NOW = Date.parse("2026-11-16T10:00:00Z");

test("signature is HMAC-SHA256 of '<timestamp>.<raw body>' in hex, prefixed sha256=", () => {
  const body = '{"a":1}';
  const expected = crypto.createHmac("sha256", SECRET).update(`1700000000.${body}`).digest("hex");
  assert.equal(sign(SECRET, "1700000000", body), `sha256=${expected}`);
  assert.equal(sign(SECRET, "1700000000", Buffer.from(body)), `sha256=${expected}`);
});

test("a signed request verifies; a GET is signed with an empty body", () => {
  const body = JSON.stringify({ recipientId: "1", text: "hola ñ 😀" });
  const headers = signedHeaders(SECRET, body, NOW);
  assert.equal(headers["X-Bridge-Timestamp"], String(NOW / 1000));
  const ok = verify({ secret: SECRET, timestamp: headers["X-Bridge-Timestamp"], signature: headers["X-Bridge-Signature"], rawBody: Buffer.from(body), nowMs: NOW });
  assert.deepEqual(ok, { ok: true });

  const get = signedHeaders(SECRET, "", NOW);
  assert.equal(verify({ secret: SECRET, timestamp: get["X-Bridge-Timestamp"], signature: get["X-Bridge-Signature"], nowMs: NOW }).ok, true);
});

test("bad signature, other secret, changed body, malformed headers: rejected", () => {
  const body = '{"x":1}';
  const h = signedHeaders(SECRET, body, NOW);
  const check = (over) =>
    verify({ secret: SECRET, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: body, nowMs: NOW, ...over });
  assert.equal(check({ rawBody: '{"x":2}' }).ok, false);
  assert.equal(check({ secret: "other" }).ok, false);
  assert.equal(check({ signature: "sha256=" + "0".repeat(64) }).reason, "bad signature");
  assert.equal(check({ signature: undefined }).ok, false);
  assert.equal(check({ signature: "deadbeef" }).ok, false);
  assert.equal(check({ timestamp: "abc" }).ok, false);
  assert.equal(check({ secret: "" }).ok, false);
});

test("more than 300 s of skew is rejected, either way; 300 s is accepted", () => {
  const body = "";
  for (const [offset, ok] of [[300, true], [-300, true], [301, false], [-301, false]]) {
    const h = signedHeaders(SECRET, body, NOW + offset * 1000);
    const result = verify({ secret: SECRET, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: body, nowMs: NOW });
    assert.equal(result.ok, ok, `offset ${offset}`);
  }
});
