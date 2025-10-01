const axios = require("axios");
const { userDb } = require("./database");
const { logger } = require("./logger");

/**
 * Refresh Instagram long-lived token
 * Should be called when token is at least 24 hours old and expires in less than 60 days
 */
async function refreshInstagramToken() {
  try {
    const tokenRecord = await userDb.getInstagramToken();
    
    if (!tokenRecord || !tokenRecord.access_token) {
      logger.log("No token to refresh");
      return false;
    }

    const now = new Date();
    
    // Check if token exists and has expiry
    if (!tokenRecord.expires_at) {
      logger.log("Token has no expiry date, skipping refresh");
      return false;
    }

    const expiresAt = new Date(tokenRecord.expires_at);
    const updatedAt = new Date(tokenRecord.updated_at);
    
    // Calculate time since last update (in hours)
    const hoursSinceUpdate = (now - updatedAt) / (1000 * 60 * 60);
    
    // Calculate days until expiry
    const daysUntilExpiry = (expiresAt - now) / (1000 * 60 * 60 * 24);
    
    // Only refresh if:
    // 1. Token is at least 24 hours old
    // 2. Token expires in less than 60 days
    // 3. Token hasn't expired yet
    if (hoursSinceUpdate < 24) {
      logger.log(`Token too recent (${hoursSinceUpdate.toFixed(1)}h old), skipping refresh`);
      return false;
    }

    if (daysUntilExpiry > 60) {
      logger.log(`Token still fresh (expires in ${daysUntilExpiry.toFixed(1)} days), skipping refresh`);
      return false;
    }

    if (daysUntilExpiry <= 0) {
      logger.error("Token has expired! Please re-authorize via OAuth.");
      return false;
    }

    logger.log(`Refreshing token (expires in ${daysUntilExpiry.toFixed(1)} days)...`);

    const response = await axios.get("https://graph.instagram.com/refresh_access_token", {
      params: {
        grant_type: "ig_refresh_token",
        access_token: tokenRecord.access_token,
      },
    });

    const { access_token: newToken, expires_in: expiresIn, token_type } = response.data;
    
    const newExpiresAt = expiresIn
      ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
      : null;

    await userDb.saveInstagramToken(newToken, newExpiresAt);
    
    logger.log(`✓ Token refreshed successfully (new expiry: ${newExpiresAt}, type: ${token_type})`);
    return true;
  } catch (error) {
    logger.error("Token refresh failed", error?.response?.data || error?.message);
    return false;
  }
}

/**
 * Start periodic token refresh check (runs every 24 hours)
 */
function startTokenRefreshScheduler() {
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  // Run initial check after 1 minute
  setTimeout(() => {
    logger.log("Running initial token refresh check...");
    refreshInstagramToken();
  }, 60 * 1000);

  // Then run every 24 hours
  setInterval(() => {
    logger.log("Running scheduled token refresh check...");
    refreshInstagramToken();
  }, CHECK_INTERVAL);

  logger.log("Token refresh scheduler started (checks every 24h)");
}

module.exports = { refreshInstagramToken, startTokenRefreshScheduler };

