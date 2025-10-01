const axios = require("axios");
const { logger } = require("./logger");
const { userDb } = require("./database");

async function getAccessToken() {
  const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID || "";
  if (!instagramAccountId) {
    throw new Error("INSTAGRAM_ACCOUNT_ID is not configured");
  }

  const record = await userDb.getInstagramAccount(instagramAccountId);
  if (!record || !record.access_token) {
    throw new Error("No stored Instagram access token. Complete OAuth first.");
  }

  return { igUserId: instagramAccountId, accessToken: record.access_token };
}

class InstagramAPI {
  async getUserProfile(userId) {
    const { accessToken } = await getAccessToken();

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
      logger.error(
        `Failed to fetch profile for user ${userId}`,
        error?.response?.data || error?.message,
      );

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
