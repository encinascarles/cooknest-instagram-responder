// The Graph calls behind instagramAPI, against a fake HTTP client (no network)
const test = require("node:test");
const assert = require("node:assert/strict");
const { InstagramAPI, toGraphError, MESSAGE_FIELDS } = require("../src/instagram-api");
const messagesPage = require("./fixtures/graph-messages-page.json");

const NOW = Date.parse("2026-11-16T10:00:00Z");

function fakeHttp(routes) {
  const calls = [];
  const answer = (method) => async (url, bodyOrConfig, maybeConfig) => {
    const config = method === "get" ? bodyOrConfig : maybeConfig;
    const body = method === "post" ? bodyOrConfig : undefined;
    calls.push({ method, url, body, params: config?.params });
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route.reply({ url, body, params: config?.params });
  };
  return { calls, get: answer("get"), post: answer("post") };
}

function graphFailure(status, error) {
  const failure = new Error(`Request failed with status code ${status}`);
  failure.response = { status, data: { error } };
  return failure;
}

function makeApi(http, { token = { access_token: "TOKEN", expires_at: "2027-01-10T00:00:00.000Z" } } = {}) {
  const notified = [];
  const api = new InstagramAPI({
    http,
    tokens: () => ({ getInstagramToken: async () => token }),
    notifier: { notifyTokenExpired: async () => notified.push("expired"), notifyError: async () => notified.push("error") },
    accountId: () => "17841473716984633",
    now: () => NOW,
  });
  return { api, notified };
}

test("profile: asks for profile_pic and maps it to profilePic", async () => {
  const http = fakeHttp([
    {
      method: "get",
      match: /\/v20\.0\/9001$/,
      reply: () => ({ data: { name: "Ana", username: "ana", profile_pic: "https://cdn.test/ana.jpg", follower_count: 12, is_verified_user: false, is_user_follow_business: true, is_business_follow_user: false } }),
    },
  ]);
  const { api } = makeApi(http);
  const profile = await api.fetchUserProfile("9001");
  assert.match(http.calls[0].params.fields, /(^|,)profile_pic(,|$)/);
  assert.deepEqual(profile, { name: "Ana", username: "ana", followerCount: 12, isUserFollowBusiness: true, isBusinessFollowUser: false, isVerifiedUser: false, profilePic: "https://cdn.test/ana.jpg" });
});

test("send: POST /<ig user>/messages with reply_to, never a tag, token as a parameter", async () => {
  const http = fakeHttp([{ method: "post", match: /\/17841473716984633\/messages$/, reply: () => ({ data: { recipient_id: "9001", message_id: "mid.1" } }) }]);
  const { api } = makeApi(http);
  const result = await api.sendMessage("9001", { text: "Hola" }, { replyToMid: "mid.0" });
  assert.deepEqual(result, { recipient_id: "9001", message_id: "mid.1" });
  assert.deepEqual(http.calls[0].body, { recipient: { id: "9001" }, message: { text: "Hola" }, reply_to: { mid: "mid.0" } });
  assert.equal(http.calls[0].params.access_token, "TOKEN");
  assert.ok(!("tag" in http.calls[0].body) && !("messaging_type" in http.calls[0].body));
  assert.ok(!http.calls[0].url.includes("TOKEN"));
});

test("send: Graph's window error comes back verbatim (status, code 10, subcode 2534022)", async () => {
  const http = fakeHttp([
    {
      method: "post",
      match: /messages$/,
      reply: () => {
        throw graphFailure(400, { message: "This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2534022, fbtrace_id: "x" });
      },
    },
  ]);
  const { api, notified } = makeApi(http);
  const error = await api.sendMessage("9001", { text: "Hola" }).catch((e) => e);
  assert.deepEqual(toGraphError(error), {
    status: 400,
    body: { error: { status: 400, code: 10, subcode: 2534022, message: "This message is sent outside of allowed window." } },
  });
  assert.deepEqual(notified, []);
});

test("no token / expired token: 503 without calling Graph and without Telegram", async () => {
  const http = fakeHttp([]);
  for (const token of [null, { access_token: "T", expires_at: "2026-11-01T00:00:00.000Z" }]) {
    const { api, notified } = makeApi(http, { token });
    const error = await api.listConversations().catch((e) => e);
    assert.equal(toGraphError(error).status, 503);
    assert.deepEqual(notified, []);
  }
  assert.equal(http.calls.length, 0);
});

test("conversations: Graph shape -> {id, updatedTime, participants}, next = cursor only when paging.next", async () => {
  const pages = {
    first: {
      data: [
        { id: "aWdfZAG06conv1", updated_time: "2026-11-16T09:44:55+0000", participants: { data: [{ username: "cooknest.app", id: "17841473716984633" }, { username: "someone.test", id: "900000000000001" }] } },
      ],
      paging: { cursors: { before: "B", after: "C2" }, next: "https://graph.instagram.com/v20.0/me/conversations?access_token=SECRET&after=C2" },
    },
    last: { data: [], paging: { cursors: { before: "B", after: "C3" } } },
  };
  const http = fakeHttp([{ method: "get", match: /\/me\/conversations$/, reply: ({ params }) => ({ data: params.after ? pages.last : pages.first }) }]);
  const { api } = makeApi(http);
  const first = await api.listConversations();
  assert.deepEqual(first, {
    data: [{ id: "aWdfZAG06conv1", updatedTime: "2026-11-16T09:44:55+0000", participants: [{ id: "17841473716984633", username: "cooknest.app" }, { id: "900000000000001", username: "someone.test" }] }],
    next: "C2",
  });
  assert.deepEqual(
    { platform: http.calls[0].params.platform, fields: http.calls[0].params.fields, limit: http.calls[0].params.limit },
    { platform: "instagram", fields: "updated_time,participants", limit: 50 }
  );
  assert.equal("after" in http.calls[0].params, false);
  const last = await api.listConversations("C2");
  assert.equal(http.calls[1].params.after, "C2");
  assert.deepEqual(last, { data: [], next: null });
});

test("messages: Graph messages as they come, minus nested paging (it carries the token)", async () => {
  const http = fakeHttp([{ method: "get", match: /\/aWdfZAG06conv1\/messages$/, reply: () => ({ data: messagesPage }) }]);
  const { api } = makeApi(http);
  const page = await api.listMessages("aWdfZAG06conv1");
  assert.equal(http.calls[0].params.fields, MESSAGE_FIELDS);
  assert.equal(http.calls[0].params.limit, 50);
  assert.equal(page.next, "QVFIUnextcursor");
  assert.equal(page.data.length, 3);
  assert.deepEqual(page.data[0], messagesPage.data[0]);
  assert.deepEqual(page.data[2].shares, { data: [{ link: "https://www.instagram.com/reel/TESTREEL01/" }] });
  assert.equal(page.data[1].attachments.data[0].video_data.url, "https://lookaside.fbsbx.test/v.mp4");
  assert.equal(page.data[2].reactions.data[0].emoji, "❤");
  assert.ok(!JSON.stringify(page).includes("SECRET-TOKEN"));
});

test("account and token info for health", async () => {
  const http = fakeHttp([{ method: "get", match: /\/me$/, reply: () => ({ data: { user_id: "17841473716984633", username: "cooknest.app" } }) }]);
  const { api } = makeApi(http);
  assert.deepEqual(await api.getAccount(), { igUserId: "17841473716984633", username: "cooknest.app" });
  await api.getAccount();
  assert.equal(http.calls.length, 1, "cached");
  assert.deepEqual(await api.getTokenInfo(), { present: true, expiresAt: "2027-01-10T00:00:00.000Z", expired: false });
});
