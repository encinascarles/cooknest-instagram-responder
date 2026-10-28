const express = require("express");
const morgan = require("morgan");
const path = require("path");
require("dotenv").config();

const { userDb } = require("./database");
const { logger } = require("./logger");
const { instagramAPI } = require("./instagram-api");
const { telegramNotifier } = require("./telegram");
const { instagramAuthRouter } = require("./instagram-auth");
const { startTokenRefreshScheduler } = require("./token-refresh");
const { sendMessage } = require("./sender");
const { Responder } = require("./responder");
const { initLanguageDetector, detectLanguage } = require("./language");

const replyMode = process.env.REPLY_MODE === "live" ? "live" : "shadow";
const testUserIds = (process.env.TEST_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const followerThreshold = Number.parseInt(process.env.CREATOR_FOLLOWER_THRESHOLD || "", 10);

const responder = new Responder({
  store: userDb,
  profiles: { get: (userId, now) => instagramAPI.getProfile(userId, userDb, now) },
  sender: { send: sendMessage },
  notifier: {
    message: async (profile, text) => {
      if (process.env.NOTIFY_NON_REEL_MESSAGES !== "true") return;
      await telegramNotifier.notifyImportantMessage(profile, text);
    },
    recipeNotAnswered: (profile, text, label) => telegramNotifier.notifyRecipeNotAnswered(profile, text, label),
    repeatedReels: (profile, count) => telegramNotifier.notifyRepeatedReels(profile, count),
    needsHelp: (profile) => telegramNotifier.notifyNeedsHelp(profile),
  },
  logger,
  detectLanguage,
  config: {
    replyMode,
    testUserIds,
    botAccountId: process.env.INSTAGRAM_ACCOUNT_ID || "",
    engine: {
      publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://carlotes.ganxo.net",
      creatorFollowerThreshold: Number.isFinite(followerThreshold) ? followerThreshold : 5000,
    },
  },
});

const app = express();

// Logging and body parsing
app.use(morgan("tiny"));
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health check
app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

// Tutorial video and other public files (sent to Instagram as attachments)
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1d" }));

// OAuth routes
app.use(instagramAuthRouter);

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  logger.unauthorizedWebhook();
  return res.sendStatus(403);
});

// Webhook receiver (POST)
app.post("/webhook", (req, res) => {
  const payload = req.body;

  // Immediately acknowledge receipt to Meta
  res.sendStatus(200);

  // Log-only mode for proxy testing
  const logOnly =
    process.env.LOG_ONLY_WEBHOOKS === "1" ||
    process.env.LOG_ONLY_WEBHOOKS === "true";
  
  if (logOnly) {
    // eslint-disable-next-line no-console
    console.log("Incoming webhook payload:", JSON.stringify(payload, null, 2));
    return;
  }

  // IG DMs may arrive as object 'instagram' (IG messaging) or 'page' (Messenger entrypoint). Handle both.
  if (!payload || (payload.object !== "instagram" && payload.object !== "page")) {
    return;
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messagingEvents) {
      responder.handleWebhookEvent(event).catch((error) => {
        logger.error("Error processing webhook", error);
      });
    }
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, async () => {
  logger.log(`CookNest IG Responder listening on port ${port} (REPLY_MODE=${replyMode}, test users: ${testUserIds.length})`);

  try {
    await initLanguageDetector();
  } catch (error) {
    logger.error("Failed to load the language detector, replies will default to Spanish", error);
  }
  
  // Check if we have a valid token
  let hasValidToken = false;
  try {
    const tokenRecord = await userDb.getInstagramToken();
    if (tokenRecord && tokenRecord.access_token) {
      // Check if token is expired
      if (tokenRecord.expires_at) {
        const expiresAt = new Date(tokenRecord.expires_at);
        const now = new Date();
        hasValidToken = expiresAt > now;
      } else {
        hasValidToken = true; // No expiry date means we assume it's valid
      }
    }
  } catch (error) {
    logger.error("Failed to check token status on startup", error);
  }
  
  // Notify bot startup status via Telegram
  await telegramNotifier.notifyBotStarted(hasValidToken);
  
  // Start token refresh scheduler
  startTokenRefreshScheduler();
});
