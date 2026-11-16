const axios = require("axios");
const { logger, describeError } = require("./logger");
const { userDb } = require("./database");
const { telegramNotifier } = require("./telegram");
const { GRAPH_VERSION } = require("./sender");

const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

// Instagram User Profile API (Instagram API with Instagram Login). Needs
// instagram_business_basic + instagram_business_manage_messages and the user's
// consent, which they give by messaging us.
const PROFILE_FIELDS = [
  "name",
  "username",
  "profile_pic",
  "follower_count",
  "is_user_follow_business",
  "is_business_follow_user",
  "is_verified_user",
].join(",");
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;

// Remy reads the inbox through these (see README "Remy bridge")
const CONVERSATION_FIELDS = "updated_time,participants";
const MESSAGE_FIELDS = "id,message,created_time,from,to,attachments,shares,story,reactions,is_unsupported";
const PAGE_LIMIT = 50;
const ACCOUNT_CACHE_MS = 60 * 60 * 1000;

class InstagramAPI {
  /**
   * @param {object} [deps]
   * @param {{get: Function, post: Function}} [deps.http] axios-like client
   * @param {() => object} [deps.tokens] store with getInstagramToken()
   * @param {object} [deps.notifier] Telegram
   * @param {() => string} [deps.accountId] business IG user id
   * @param {() => number} [deps.now]
   */
  constructor({ http, tokens, notifier, accountId, now } = {}) {
    this.http = http || axios;
    this.tokens = tokens || (() => userDb);
    this.notifier = notifier || telegramNotifier;
    this.accountId = accountId || (() => process.env.INSTAGRAM_ACCOUNT_ID || "");
    this.now = now || (() => Date.now());
    this.account = null; // {value, at}
  }

  // The stored token; tells Telegram when it is missing or expired
  async getAccessToken({ notify = true } = {}) {
    const tokenRecord = await this.tokens().getInstagramToken();
    if (!tokenRecord || !tokenRecord.access_token) {
      if (notify) await this.notifier.notifyTokenExpired();
      throw bridgeError(503, "No stored Instagram access token. Complete OAuth first.");
    }

    // Check if token is expired
    if (tokenRecord.expires_at) {
      const expiresAt = new Date(tokenRecord.expires_at);
      if (expiresAt.getTime() <= this.now()) {
        if (notify) await this.notifier.notifyTokenExpired();
        throw bridgeError(503, "Instagram token has expired");
      }
    }

    return tokenRecord.access_token;
  }

  // Throws when the profile cannot be fetched
  async fetchUserProfile(userId) {
    const accessToken = await this.getAccessToken();
    // Use Instagram Graph API endpoint with IGSID (Instagram-scoped ID)
    const url = `${GRAPH_BASE}/${userId}`;
    const response = await this.http.get(url, {
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
      profilePic: data.profile_pic || null,
    };
  }

  /**
   * Profile for decide(), Telegram and Remy, cached 24 h in the store.
   * @returns {Promise<{status: "ok"|"failed", profile: object, error?: Error}>}
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
        await this.notifier.notifyError("api_error", "Failed to fetch user profile due to token issue", errorDetail);
      }
      const fallback = cached?.profile || { name: null, username: null };
      return { status: "failed", profile: { ...fallback }, error };
    }
  }

  // --- Remy bridge. These never notify Telegram: Remy shows the error itself. ---

  /**
   * Sends one message for Remy. Never with a tag (HUMAN_AGENT is not approved).
   * @param {string} recipientId IGSID
   * @param {object} message Graph message: {text} or {attachment: {type, payload: {url}}}
   * @param {{replyToMid?: string}} [options]
   * @returns {Promise<{recipient_id: string, message_id: string}>}
   */
  async sendMessage(recipientId, message, { replyToMid } = {}) {
    const accessToken = await this.getAccessToken({ notify: false });
    const igUserId = this.accountId();
    if (!igUserId) throw bridgeError(503, "INSTAGRAM_ACCOUNT_ID (business IG user ID) is not configured");
    const body = { recipient: { id: recipientId }, message };
    if (replyToMid) body.reply_to = { mid: replyToMid };
    const response = await this.http.post(`${GRAPH_BASE}/${igUserId}/messages`, body, {
      params: { access_token: accessToken },
      timeout: 60000,
    });
    return response.data;
  }

  /**
   * One page of conversations, newest first.
   * @returns {Promise<{data: Array<{id, updatedTime, participants: Array<{id, username}>}>, next: string|null}>}
   */
  async listConversations(after) {
    const accessToken = await this.getAccessToken({ notify: false });
    const params = { platform: "instagram", fields: CONVERSATION_FIELDS, limit: PAGE_LIMIT, access_token: accessToken };
    if (after) params.after = after;
    const response = await this.http.get(`${GRAPH_BASE}/me/conversations`, { params, timeout: 20000 });
    const body = response.data || {};
    const data = (Array.isArray(body.data) ? body.data : []).map((conversation) => ({
      id: conversation.id,
      updatedTime: conversation.updated_time ?? null,
      participants: (conversation.participants?.data || []).map(({ id, username }) => ({ id, username: username ?? null })),
    }));
    return { data, next: nextCursor(body.paging) };
  }

  /**
   * One page of a conversation's messages, newest first, as Graph returns them
   * (nested paging links removed: they carry the access token).
   */
  async listMessages(conversationId, after) {
    const accessToken = await this.getAccessToken({ notify: false });
    const params = { fields: MESSAGE_FIELDS, limit: PAGE_LIMIT, access_token: accessToken };
    if (after) params.after = after;
    const url = `${GRAPH_BASE}/${encodeURIComponent(conversationId)}/messages`;
    const response = await this.http.get(url, { params, timeout: 20000 });
    const body = response.data || {};
    const data = (Array.isArray(body.data) ? body.data : []).map(withoutPaging);
    return { data, next: nextCursor(body.paging) };
  }

  // {igUserId, username} of the business account, cached 1 h
  async getAccount() {
    const now = this.now();
    if (this.account && now - this.account.at < ACCOUNT_CACHE_MS) return this.account.value;
    const accessToken = await this.getAccessToken({ notify: false });
    const response = await this.http.get(`${GRAPH_BASE}/me`, {
      params: { fields: "user_id,username", access_token: accessToken },
      timeout: 10000,
    });
    const data = response.data || {};
    const value = { igUserId: data.user_id ? String(data.user_id) : null, username: data.username || null };
    this.account = { value, at: now };
    return value;
  }

  // {present, expiresAt (ISO or null), expired}
  async getTokenInfo() {
    const tokenRecord = await this.tokens().getInstagramToken();
    if (!tokenRecord || !tokenRecord.access_token) return { present: false, expiresAt: null, expired: false };
    if (!tokenRecord.expires_at) return { present: true, expiresAt: null, expired: false };
    const expiresAt = new Date(tokenRecord.expires_at);
    if (Number.isNaN(expiresAt.getTime())) return { present: true, expiresAt: String(tokenRecord.expires_at), expired: false };
    return { present: true, expiresAt: expiresAt.toISOString(), expired: expiresAt.getTime() <= this.now() };
  }
}

function bridgeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Graph's `after` cursor, only when there is a next page
function nextCursor(paging) {
  if (!paging || !paging.next) return null;
  return paging.cursors?.after || null;
}

function withoutPaging(value) {
  if (Array.isArray(value)) return value.map(withoutPaging);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "paging") continue;
    copy[key] = withoutPaging(inner);
  }
  return copy;
}

/**
 * Graph's error as Remy gets it: HTTP status + {error: {status, code, subcode, message}}.
 * Graph's 4xx/5xx status is kept; no answer at all (network) is a 502.
 */
function toGraphError(error) {
  const response = error?.response;
  if (response && response.status) {
    const graph = response.data?.error || {};
    const status = response.status;
    return {
      status,
      body: {
        error: {
          status,
          code: graph.code ?? null,
          subcode: graph.error_subcode ?? null,
          message: graph.message || describeError(error),
        },
      },
    };
  }
  const status = error?.status || 502;
  return { status, body: { error: { status, code: null, subcode: null, message: error?.message || describeError(error) } } };
}

const instagramAPI = new InstagramAPI();

module.exports = {
  instagramAPI,
  InstagramAPI,
  toGraphError,
  PROFILE_FIELDS,
  PROFILE_CACHE_MS,
  CONVERSATION_FIELDS,
  MESSAGE_FIELDS,
};
