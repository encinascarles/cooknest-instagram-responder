const axios = require("axios");
const { logger } = require("./logger");
const { userDb } = require("./database");
const { telegramNotifier } = require("./telegram");

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
  async getUserProfile(userId) {
    const accessToken = await getAccessToken();

    try {
      const url = `https://graph.facebook.com/v20.0/${userId}`;
      const response = await axios.get(url, {
        params: {
          access_token: accessToken,
          fields: "name,username,profile_pic",
        },
        timeout: 10000,
      });

      return {
        user_id: userId,
        username: response.data.username || null,
        full_name: response.data.name || null,
        profile_pic: response.data.profile_pic || null,
      };
    } catch (error) {
      // Log error but don't throw - we'll use fallback data
      const errorDetail = error?.response?.data?.error?.message || error?.message;
      const errorCode = error?.response?.data?.error?.code;
      
      logger.error(
        `Failed to fetch profile for user ${userId}`,
        error?.response?.data || error?.message,
      );

      // Check if it's a critical token error
      if (errorCode === 190 || errorDetail?.toLowerCase().includes('token') || errorDetail?.toLowerCase().includes('oauth')) {
        await telegramNotifier.notifyError(
          'api_error',
          `Failed to fetch user profile due to token issue`,
          errorDetail
        );
      }

      // Return minimal profile data
      return {
        user_id: userId,
        username: null,
        full_name: `User ${userId.slice(-8)}`, // Last 8 digits as fallback name
        profile_pic: null,
      };
    }
  }

  async getOrUpdateUserProfile(userId, userDb) {
    try {
      // Check if we have recent profile data (within 7 days)
      const existingProfile = await userDb.getUserProfile(userId);
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (existingProfile && existingProfile.last_profile_update) {
        const lastUpdate = new Date(existingProfile.last_profile_update);
        if (lastUpdate > weekAgo) {
          // Profile is recent enough, use cached data
          return existingProfile;
        }
      }

      // Fetch fresh profile data
      const profileData = await this.getUserProfile(userId);

      // Update database with fresh data
      await userDb.updateUserProfile(userId, profileData);

      return profileData;
    } catch (error) {
      logger.error(`Error getting user profile for ${userId}`, error);

      // Return fallback profile
      return {
        user_id: userId,
        username: null,
        full_name: `User ${userId.slice(-8)}`,
        profile_pic: null,
      };
    }
  }
}

const instagramAPI = new InstagramAPI();

module.exports = { instagramAPI };
