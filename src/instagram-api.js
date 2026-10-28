const axios = require("axios");
const { logger, describeError } = require("./logger");
const { userDb } = require("./database");
const { telegramNotifier } = require("./telegram");
const { GRAPH_VERSION } = require("./sender");

// Instagram User Profile API (Instagram API with Instagram Login). Needs
// instagram_business_basic + instagram_business_manage_messages and the user's
// consent, which they give by messaging us.
const PROFILE_FIELDS = [
  "name",
  "username",
  "follower_count",
  "is_user_follow_business",
  "is_business_follow_user",
  "is_verified_user",
].join(",");
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;

async function getAccessToken() {
  const tokenRecord = await userDb.getInstagramToken();
  if (!tokenRecord || !tokenRecord.access_token) {
    const error = new Error("No stored Instagram access token. Complete OAuth first.");
    await telegramNotifier.notifyTokenExpired();
    throw error;
  }

  // Check if token is expired
  if (tokenRecord.expires_at) {
    const expiresAt = new Date(tokenRecord.expires_at);
    const now = new Date();
    if (expiresAt <= now) {
      const error = new Error("Instagram token has expired");
      await telegramNotifier.notifyTokenExpired();
      throw error;
    }
  }

  return tokenRecord.access_token;
}

class InstagramAPI {
  // Throws when the profile cannot be fetched
  async fetchUserProfile(userId) {
    const accessToken = await getAccessToken();
    // Use Instagram Graph API endpoint with IGSID (Instagram-scoped ID)
    const url = `https://graph.instagram.com/${GRAPH_VERSION}/${userId}`;
    const response = await axios.get(url, {
      params: { access_token: accessToken, fields: PROFILE_FIELDS },
      timeout: 10000,
    });
    const data = response.data || {};
    return {
      name: data.name || null,
      username: data.username || null,
      followerCount: typeof data.follower_count === "number" ? data.follower_count : null,
      isUserFollowBusiness: Boolean(data.is_user_follow_business),
      isBusinessFollowUser: Boolean(data.is_business_follow_user),
      isVerifiedUser: Boolean(data.is_verified_user),
    };
  }

  /**
   * Profile for decide() and Telegram, cached 24 h in the store.
   * @returns {Promise<{status: "ok"|"failed", profile: object}>}
   */
  async getProfile(userId, store, now = Date.now()) {
    let cached = null;
    try {
      cached = await store.getCachedProfile(userId);
    } catch (error) {
      logger.error(`Failed to read cached profile for ${userId}`, error);
    }
    if (cached && typeof cached.checkedAt === "number" && now - cached.checkedAt < PROFILE_CACHE_MS) {
      return { status: "ok", profile: cached.profile };
    }

    try {
      const profile = await this.fetchUserProfile(userId);
      await store.saveProfile(userId, profile, now);
      return { status: "ok", profile };
    } catch (error) {
      const errorDetail = error?.response?.data?.error?.message || describeError(error);
      const errorCode = error?.response?.data?.error?.code;
      logger.error(`Failed to fetch profile for user ${userId}`, error);

      // Check if it's a critical token error
      if (errorCode === 190 || errorDetail?.toLowerCase().includes("oauth")) {
        await telegramNotifier.notifyError("api_error", "Failed to fetch user profile due to token issue", errorDetail);
      }
      const fallback = cached?.profile || { name: null, username: null };
      return { status: "failed", profile: { ...fallback } };
    }
  }
}

const instagramAPI = new InstagramAPI();

module.exports = { instagramAPI, PROFILE_FIELDS, PROFILE_CACHE_MS };
