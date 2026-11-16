// Remy -> responder: /internal/remy/* (see README "Remy bridge"). Remy reaches
// these over the LAN; every request is signed (src/remy-signature.js). Without
// REMY_BRIDGE_SECRET they all answer 404; through Cloudflare, 403.

const express = require("express");
const { verify, TIMESTAMP_HEADER, SIGNATURE_HEADER } = require("./remy-signature");
const { toRemyProfile } = require("./remy-bridge");
const { toGraphError } = require("./instagram-api");
const { classifyFile } = require("./remy-media");

// A 25 MB file is ~33.4 MB of base64
const MAX_BODY = "36mb";
const IGSID_RE = /^\d{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(res, status, message) {
  return res.status(status).json({ error: { status, message } });
}

function cursorParam(value) {
  return typeof value === "string" && value && value.length <= 2000 ? value : undefined;
}

/**
 * @param {object} deps
 * @param {string} deps.secret REMY_BRIDGE_SECRET (empty: everything 404)
 * @param {object} deps.api instagramAPI (sendMessage, getProfile, listConversations, listMessages, getAccount, getTokenInfo)
 * @param {object} deps.store UserDatabase or MemoryStore
 * @param {object} deps.responder trackInflight(userId, promise), recordHumanMessage(userId, at)
 * @param {object} deps.media MediaStore
 * @param {object} [deps.bridge] RemyBridge (null when REMY_FORWARD_URL is not set)
 * @param {string} [deps.accountId] INSTAGRAM_ACCOUNT_ID
 * @param {{now: () => number}} [deps.clock]
 * @param {object} [deps.logger]
 */
function createRemyRouter({ secret, api, store, responder, media, bridge = null, accountId = "", clock, logger }) {
  const router = express.Router();
  const now = () => (clock ? clock.now() : Date.now());
  const log = logger || { log() {}, error() {} };
  const sending = new Map(); // idempotencyKey -> promise of the answer

  router.use((req, res, next) => {
    if (!secret) return fail(res, 404, "Not found");
    // Came through the public Cloudflare host: Remy only uses the LAN
    if (req.headers["cf-connecting-ip"] || req.headers["cf-ray"]) return fail(res, 403, "Forbidden");
    return next();
  });

  router.use(
    express.json({
      limit: MAX_BODY,
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  router.use((req, res, next) => {
    const check = verify({
      secret,
      timestamp: req.get(TIMESTAMP_HEADER),
      signature: req.get(SIGNATURE_HEADER),
      rawBody: req.rawBody || "",
      nowMs: now(),
    });
    if (!check.ok) return fail(res, 401, check.reason);
    return next();
  });

  router.post("/send", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const key = body.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 200) {
      return fail(res, 400, "idempotencyKey is required (a string up to 200 characters)");
    }
    // A duplicate, concurrent or later, gets the first answer and never sends again
    let work = sending.get(key);
    if (!work) {
      work = (async () => {
        const stored = await store.getIdempotentAnswer(key, now());
        if (stored) return stored;
        const answer = await send(body);
        try {
          await store.saveIdempotentAnswer(key, answer.status, answer.body, now());
        } catch (error) {
          log.error(`Remy send: could not store the answer for ${key}`, error);
        }
        return answer;
      })();
      sending.set(key, work);
      work.catch(() => {}).then(() => sending.delete(key));
    }
    try {
      const answer = await work;
      return res.status(answer.status).json(answer.body);
    } catch (error) {
      log.error("Remy send failed", error);
      return fail(res, 500, "Internal error");
    }
  });

  async function send(body) {
    const { recipientId, text, file, replyToMid } = body;
    const invalid = (status, message) => ({ status, body: { error: { status, message } } });
    if (typeof recipientId !== "string" || !IGSID_RE.test(recipientId)) return invalid(400, "recipientId must be an Instagram-scoped id (digits)");
    if (text !== undefined && text !== null && typeof text !== "string") return invalid(400, "text must be a string");
    if (replyToMid !== undefined && replyToMid !== null && typeof replyToMid !== "string") return invalid(400, "replyToMid must be a string");
    const hasText = typeof text === "string" && text.trim() !== "";
    if (!hasText && !file) return invalid(400, "text or file is required");

    let attachment = null;
    if (file) {
      if (typeof file !== "object" || typeof file.dataBase64 !== "string") return invalid(422, "file must be {filename, contentType, dataBase64}");
      const data = file.dataBase64.replace(/\s+/g, "");
      if (!BASE64_RE.test(data) || data.length % 4 === 1) return invalid(422, "file.dataBase64 is not valid base64");
      const buffer = Buffer.from(data, "base64");
      const kind = classifyFile({ filename: file.filename, contentType: file.contentType, size: buffer.length });
      if (!kind.ok) return invalid(422, kind.message);
      attachment = { buffer, ...kind };
    }

    const messageIds = [];
    const operation = (async () => {
      try {
        // Written before anything is sent: a disk error sends nothing
        const hosted = attachment ? await media.put(attachment.buffer, attachment) : null;
        const messages = [];
        if (hasText) messages.push({ text });
        if (hosted) messages.push({ attachment: { type: attachment.type, payload: { url: hosted.url } } });

        for (const message of messages) {
          const options = messageIds.length === 0 && replyToMid ? { replyToMid } : {};
          const response = await api.sendMessage(recipientId, message, options);
          const mid = response && response.message_id;
          if (!mid) continue;
          messageIds.push(mid);
          const at = now();
          try {
            await store.recordRemyMessage(mid, recipientId, at);
            // A human holds this conversation now, as when typed on the phone
            if (messageIds.length === 1) await responder.recordHumanMessage(recipientId, at);
          } catch (error) {
            log.error(`Remy send: could not record ${mid} for ${recipientId}`, error);
          }
        }
        log.log(`Remy sent ${messageIds.length} message(s) to ${recipientId}`);
        return { status: 200, body: { messageIds } };
      } catch (error) {
        log.error(`Remy send to ${recipientId} failed`, error);
        const answer = toGraphError(error);
        // Partly sent (the text went, the file did not): say which
        if (messageIds.length > 0) answer.body.messageIds = [...messageIds];
        return answer;
      }
    })();
    // An echo of this send waits for it, so it is never taken for a human's
    responder.trackInflight(recipientId, operation);
    return operation;
  }

  router.get("/profile/:igsid", async (req, res) => {
    const { igsid } = req.params;
    if (!IGSID_RE.test(igsid)) return fail(res, 400, "igsid must be digits");
    try {
      const result = await api.getProfile(igsid, store, now());
      if (result.status === "ok") return res.json(toRemyProfile(igsid, result.profile));
      const { status, body } = result.error ? toGraphError(result.error) : { status: 502, body: { error: { status: 502, message: "Profile not available" } } };
      return res.status(status).json(body);
    } catch (error) {
      const { status, body } = toGraphError(error);
      return res.status(status).json(body);
    }
  });

  router.get("/conversations", async (req, res) => {
    try {
      return res.json(await api.listConversations(cursorParam(req.query.after)));
    } catch (error) {
      const { status, body } = toGraphError(error);
      return res.status(status).json(body);
    }
  });

  router.get("/conversations/:id/messages", async (req, res) => {
    if (!/^[\w-]{1,500}$/.test(req.params.id)) return fail(res, 400, "Bad conversation id");
    try {
      return res.json(await api.listMessages(req.params.id, cursorParam(req.query.after)));
    } catch (error) {
      const { status, body } = toGraphError(error);
      return res.status(status).json(body);
    }
  });

  router.get("/health", async (_req, res) => {
    let token = { present: false, expiresAt: null, expired: false };
    try {
      token = await api.getTokenInfo();
    } catch (error) {
      log.error("Remy health: could not read the token", error);
    }
    const ok = token.present && !token.expired;
    let account = { igUserId: null, username: null };
    if (ok) {
      try {
        account = await api.getAccount();
      } catch (error) {
        log.error("Remy health: could not read the account", error);
      }
    }
    let forward;
    try {
      if (bridge) {
        forward = await bridge.health();
      } else {
        const stats = await store.outboxStats();
        forward = {
          queued: stats.queued,
          oldestAt: stats.oldestAt === null ? null : new Date(stats.oldestAt).toISOString(),
          lastOkAt: null,
          lastError: "forwarding is off: REMY_FORWARD_URL is not set",
        };
      }
    } catch (error) {
      forward = { queued: null, oldestAt: null, lastOkAt: null, lastError: `outbox unreadable: ${error.message}` };
    }
    return res.json({
      ok,
      tokenExpiresAt: token.expiresAt,
      igUserId: accountId || account.igUserId || null,
      username: account.username || null,
      forward,
    });
  });

  router.use((_req, res) => fail(res, 404, "Not found"));

  // Body parser errors
  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") return fail(res, 422, "The request is too large: Instagram takes files up to 25 MB");
    if (error.type === "entity.parse.failed") return fail(res, 400, "The body is not valid JSON");
    log.error("Remy route failed", error);
    return fail(res, error.status && error.status < 500 ? error.status : 500, "Request failed");
  });

  return router;
}

/**
 * GET /internal-media/<name>: public (Graph fetches it), no signature.
 */
function createMediaRouter({ secret, media }) {
  const router = express.Router();
  router.get("/:name", (req, res) => {
    const entry = secret && media ? media.lookup(req.params.name) : null;
    if (!entry) return res.sendStatus(404);
    res.set("Cache-Control", "no-store");
    res.type(entry.contentType);
    return res.sendFile(entry.file, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });
  return router;
}

module.exports = { createRemyRouter, createMediaRouter, MAX_BODY };
