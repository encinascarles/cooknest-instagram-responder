const express = require("express");
const axios = require("axios");

const { getConfig } = require("./config");
const { logger } = require("./logger");
const { userDb } = require("./database");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const router = express.Router();

function ensureConfig() {
  const { igAppId, igAppSecret, igRedirectUri } = getConfig();
  if (!igAppId || !igAppSecret || !igRedirectUri) {
    throw new Error(
      "Instagram OAuth configuration missing. Check IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI",
    );
  }
}

router.get("/auth/instagram/start", (req, res) => {
  try {
    ensureConfig();
    const { igAppId, igRedirectUri, igLoginScopes } = getConfig();
    const state = req.query.state || "";
    const authUrl = new URL(`https://www.instagram.com/oauth/authorize`);
    authUrl.searchParams.set("client_id", igAppId);
    authUrl.searchParams.set("redirect_uri", igRedirectUri);
    authUrl.searchParams.set("scope", igLoginScopes);
    authUrl.searchParams.set("response_type", "code");
    if (state) authUrl.searchParams.set("state", state);

    return res.redirect(authUrl.toString());
  } catch (error) {
    logger.error("Failed to start IG OAuth", error);
    return res.status(500).json({ error: "instagram_oauth_not_configured" });
  }
});
router.get("/auth/instagram/callback", async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    logger.error("Instagram OAuth error", { error, errorDescription });
    return res.status(400).json({ error, errorDescription });
  }

  if (!code) {
    return res.status(400).json({ error: "missing_code" });
  }

  logger.log(
    `Instagram OAuth callback received code ${String(code).slice(0, 6)}***`,
  );

  try {
    ensureConfig();
    const { igAppId, igAppSecret, igRedirectUri } = getConfig();

    logger.log("Exchanging short-lived Instagram code for token");
    const shortLivedResp = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: igAppId,
        client_secret: igAppSecret,
        redirect_uri: igRedirectUri,
        code,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const {
      access_token: shortLivedToken,
      user_id,
      expires_in,
    } = shortLivedResp.data;
    logger.log(
      `Received short-lived token for IG user ${user_id} (expires in ${expires_in || "?"}s)`,
    );

    // Exchange for long-lived token (valid ~60 days)
    logger.log("Exchanging for long-lived Instagram token");
    const longLivedResp = await axios.get(
      "https://graph.instagram.com/access_token",
      {
        params: {
          grant_type: "ig_exchange_token",
          client_secret: igAppSecret,
          access_token: shortLivedToken,
        },
      },
    );

    const {
      access_token: longLivedToken,
      expires_in: longExpiresIn,
      token_type: longTokenType,
    } = longLivedResp.data;

    logger.log(`Long-lived token obtained (expires in ${longExpiresIn}s)`);

    const expiresAt = longExpiresIn
      ? new Date(Date.now() + Number(longExpiresIn) * 1000).toISOString()
      : null;

    const { instagramAccountId } = getConfig();

    const storedInfo = {
      shortcut_associated_ig_user_id: instagramAccountId || null,
      authorization_user_id: String(user_id),
    };

    try {
      if (instagramAccountId) {
        await userDb.upsertInstagramAccount({
          igUserId: instagramAccountId,
          accessToken: longLivedToken,
          expiresAt,
        });
        storedInfo.persisted_under_id = instagramAccountId;
      } else {
        await userDb.upsertInstagramAccount({
          igUserId: String(user_id),
        accessToken: longLivedToken,
        expiresAt,
        });
        storedInfo.persisted_under_id = String(user_id);
      }
      logger.log(`Stored long-lived token (IG OAuth user ${user_id})`);
    } catch (storeError) {
      logger.error("Failed to store Instagram token", storeError);
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Instagram OAuth Success</title>
          <style>
            body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem; }
            pre { background: #f6f8fa; padding: 1rem; border-radius: 8px; overflow-x: auto; }
            .warn { color: #b45309; }
            .success { color: #047857; }
          </style>
        </head>
        <body>
          <h1 class="success">✅ Instagram OAuth completed</h1>
          <p class="warn"><strong>Copy the tokens below and store them securely.</strong> They will not be shown again.</p>
          <pre>${escapeHtml(
            JSON.stringify(
              {
                user_id,
                short_lived_token: shortLivedToken,
                short_lived_expires_in: expires_in,
                long_lived_token: longLivedToken,
                long_lived_expires_in: longExpiresIn,
                token_type: longTokenType || "bearer",
                stored_info: storedInfo,
              },
              null,
              2,
            ),
          )}</pre>
          <p>Long-lived tokens typically expire in ~60 days. Implement automatic refresh with the <code>fb_exchange_token</code> flow.</p>
        </body>
      </html>
    `);
  } catch (oauthError) {
    logger.error("Failed to exchange IG OAuth code", oauthError);
    const data =
      oauthError?.response?.data || oauthError?.message || "oauth_error";
    return res
      .status(500)
      .json({ error: "oauth_exchange_failed", details: data });
  }
});

module.exports = { instagramAuthRouter: router };
