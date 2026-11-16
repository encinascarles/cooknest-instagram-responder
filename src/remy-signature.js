// HMAC signature shared with Remy, used in both directions:
//   X-Bridge-Timestamp: <unix seconds>
//   X-Bridge-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
// A GET is signed with an empty body. Receivers reject more than 300 s of skew.

const crypto = require("crypto");

const TIMESTAMP_HEADER = "x-bridge-timestamp";
const SIGNATURE_HEADER = "x-bridge-signature";
const MAX_SKEW_SECONDS = 300;

function sign(secret, timestamp, rawBody = "") {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8"));
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Headers for a signed request.
 * @param {string} secret
 * @param {string|Buffer} rawBody exactly the bytes that are sent ("" for a GET)
 * @param {number} nowMs epoch milliseconds
 */
function signedHeaders(secret, rawBody, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    "X-Bridge-Timestamp": timestamp,
    "X-Bridge-Signature": sign(secret, timestamp, rawBody),
  };
}

/**
 * Checks a signed request.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verify({ secret, timestamp, signature, rawBody = "", nowMs = Date.now(), maxSkewSeconds = MAX_SKEW_SECONDS }) {
  if (!secret) return { ok: false, reason: "bridge secret not configured" };
  if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "missing or malformed X-Bridge-Timestamp" };
  }
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, reason: "missing or malformed X-Bridge-Signature" };
  }
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > maxSkewSeconds) return { ok: false, reason: `timestamp skew ${skew} s is over ${maxSkewSeconds} s` };

  const expected = Buffer.from(sign(secret, timestamp, rawBody), "utf8");
  const given = Buffer.from(signature.toLowerCase(), "utf8");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

module.exports = { sign, signedHeaders, verify, TIMESTAMP_HEADER, SIGNATURE_HEADER, MAX_SKEW_SECONDS };
