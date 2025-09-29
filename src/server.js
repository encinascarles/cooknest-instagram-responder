const express = require("express");
const morgan = require("morgan");
require("dotenv").config();

const { getConfig } = require("./config");
const { isInstagramMediaMessage } = require("./detect");
const { sendTextMessage } = require("./sender");
const { userDb } = require("./database");

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

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const { verifyToken } = getConfig();

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }
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
  // eslint-disable-next-line no-console
  console.log("Incoming webhook payload:", JSON.stringify(payload, null, 2));
  if (logOnly) {
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

        const messageText = message.text || "";
        const attachments = Array.isArray(message.attachments)
          ? message.attachments
          : [];

        const containsInstagramMedia = isInstagramMediaMessage({
          text: messageText,
          attachments,
        });

        if (containsInstagramMedia) {
          const { firstTimeMessage, returningUserMessage } = getConfig();
          try {
            // Check if user is new
            const isNew = await userDb.isNewUser(senderId);
            const messageToSend = isNew ? firstTimeMessage : returningUserMessage;
            
            // Record the user interaction
            await userDb.recordUser(senderId);
            
            // Send appropriate message
            await sendTextMessage(senderId, messageToSend);
          } catch (sendError) {
            // Silent fail; do not spam logs unless needed
            // eslint-disable-next-line no-console
            console.error(
              "Failed to send auto-reply",
              sendError?.response?.data || sendError?.message
            );
          }
        }
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "Error processing webhook:",
      error?.response?.data || error?.message
    );
  }
});

const { port } = getConfig();
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`CookNest IG Responder listening on port ${port}`);
});
