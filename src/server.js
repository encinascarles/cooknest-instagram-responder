const express = require("express");
const morgan = require("morgan");
require("dotenv").config();

const { isInstagramMediaMessage } = require("./detect");
const { sendTextMessage } = require("./sender");
const { userDb } = require("./database");
const { logger } = require("./logger");
const { instagramAPI } = require("./instagram-api");
const { telegramNotifier } = require("./telegram");
const { instagramAuthRouter } = require("./instagram-auth");
const { startTokenRefreshScheduler } = require("./token-refresh");

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
app.post("/webhook", async (req, res) => {
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

  try {
    if (!payload || !payload.object) {
      return;
    }

    // IG DMs may arrive as object 'instagram' (IG messaging) or 'page' (Messenger entrypoint). Handle both.
    if (payload.object !== "instagram" && payload.object !== "page") {
      return;
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const messagingEvents = Array.isArray(entry.messaging)
        ? entry.messaging
        : [];

      for (const event of messagingEvents) {
        const senderId = event?.sender?.id;
        const recipientId = event?.recipient?.id;
        const message = event?.message;
        if (!senderId || !message || !recipientId) {
          continue;
        }

        // Check if this is our own message (we are the sender)
        const botId = process.env.INSTAGRAM_ACCOUNT_ID || "";
        if (senderId === botId) {
          // This is a message we sent - determine if automatic or manual
          const messageText = message.text || "";
          const firstTimeMessage = process.env.IG_FIRST_TIME_MESSAGE || "¡Hola! 👋 Veo que es la primera vez que nos envías un reel. Para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest. Si no te aparece, te ayudo a configurarlo 😊";
          const returningUserMessage = process.env.IG_RETURNING_MESSAGE || "¡Gracias por enviarnos otro reel! 🙌 Recuerda: para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest.";
          const ackMessage = process.env.ACK_MESSAGE || "¡Gracias por contactarnos! 😊 Te responderemos en breve.";
          
          if (messageText === firstTimeMessage || messageText === returningUserMessage || messageText === ackMessage) {
            logger.automaticMessage(recipientId, messageText);
          } else {
            logger.manualMessage(recipientId, messageText);
          }
          
          // Update last_sent for the recipient
          try {
            await userDb.recordMessageSent(recipientId);
          } catch (dbError) {
            logger.error("Failed to record our own message", dbError);
          }
          continue; // Skip processing our own messages
        }

        const messageText = message.text || "";
        const attachments = Array.isArray(message.attachments)
          ? message.attachments
          : [];

        // Log user message
        logger.userMessage(senderId, messageText || "[attachment]");

        const containsInstagramMedia = isInstagramMediaMessage({
          text: messageText,
          attachments,
        });

        if (containsInstagramMedia) {
          const firstTimeMessage = process.env.IG_FIRST_TIME_MESSAGE || "¡Hola! 👋 Veo que es la primera vez que nos envías un reel. Para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest. Si no te aparece, te ayudo a configurarlo 😊";
          const returningUserMessage = process.env.IG_RETURNING_MESSAGE || "¡Gracias por enviarnos otro reel! 🙌 Recuerda: para guardarlo en CookNest, abre el reel, toca Compartir ▶️ y elige CookNest.";
          try {
            // Check if this is their first time sending a reel (not just first message ever)
            const isFirstTimeReel = await userDb.isFirstTimeReelUser(senderId);
            const messageToSend = isFirstTimeReel ? firstTimeMessage : returningUserMessage;
            
            // Send appropriate message
            await sendTextMessage(senderId, messageToSend);
            
            // Record that we sent a reel-specific message
            await userDb.recordReelMessageSent(senderId);
          } catch (sendError) {
            logger.error("Failed to send auto-reply", sendError?.response?.data || sendError?.message);
            // Error notification is already sent by sendTextMessage
          }
        } else {
          // Handle non-reel messages with acknowledgment and notifications
          const enableAckMessage = process.env.ENABLE_ACK_MESSAGE === "true";
          const ackMessage = process.env.ACK_MESSAGE || "¡Gracias por contactarnos! 😊 Te responderemos en breve.";
          const ackWindowDays = process.env.ACK_WINDOW_DAYS !== undefined ? parseInt(process.env.ACK_WINDOW_DAYS) : 7;
          const shouldNotify = process.env.NOTIFY_NON_REEL_MESSAGES === "true";
          
          // Check ACK eligibility FIRST (before any DB updates)
          let shouldSendAck = false;
          if (enableAckMessage) {
            try {
              shouldSendAck = await userDb.shouldSendAck(senderId, ackWindowDays);
              logger.log(`ACK Debug - User: ${senderId}, shouldSendAck: ${shouldSendAck}, windowDays: ${ackWindowDays}`);
            } catch (ackError) {
              logger.error("Failed to check ACK eligibility", ackError);
            }
          }
          
          // Send Telegram notification for non-reel messages
          if (shouldNotify) {
            try {
              const userProfile = await instagramAPI.getOrUpdateUserProfile(senderId, userDb);
              await telegramNotifier.notifyImportantMessage(userProfile, messageText || "[attachment]");
            } catch (notifyError) {
              logger.error("Failed to send Telegram notification", notifyError);
            }
          }
          
          // Send ACK if eligible
          if (shouldSendAck) {
            try {
              await sendTextMessage(senderId, ackMessage);
              await userDb.recordMessageSent(senderId);
              logger.log(`ACK sent to ${senderId}`);
            } catch (ackError) {
              logger.error("Failed to send acknowledgment", ackError?.response?.data || ackError?.message);
              // Error notification is already sent by sendTextMessage
            }
          } else if (enableAckMessage) {
            logger.log(`ACK not sent - recent message exists for ${senderId}`);
          } else {
            logger.log("ACK disabled in config");
          }
        }
      }
    }
  } catch (error) {
    logger.error("Error processing webhook", error?.response?.data || error?.message);
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, async () => {
  logger.log(`CookNest IG Responder listening on port ${port}`);
  
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
