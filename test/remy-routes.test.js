// /internal/remy/* and /internal-media/*, over loopback HTTP, with the real
// InstagramAPI on a fake Graph (no network beyond 127.0.0.1)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const express = require("express");
const { makeHarness, BOT_ID } = require("./helpers");
const { InstagramAPI } = require("../src/instagram-api");
const { MediaStore } = require("../src/remy-media");
const { createRemyRouter, createMediaRouter } = require("../src/remy-routes");
const { signedHeaders } = require("../src/remy-signature");
const messagesPage = require("./fixtures/graph-messages-page.json");

const SECRET = "remy-bridge-test-secret";
const TOKEN = "IGAAtest-token-value";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const USER = "900000000000001";

function graphFailure(status, error) {
  const failure = new Error(`Request failed with status code ${status}`);
  failure.response = { status, data: { error } };
  return failure;
}

// Graph as the routes see it through InstagramAPI
function fakeGraph() {
  const graph = { calls: [], sends: [], gate: null, failSend: null, n: 0 };
  graph.post = async (url, body, config) => {
    graph.calls.push({ method: "post", url, body, params: config.params });
    if (!/\/messages$/.test(url)) throw new Error(`unexpected POST ${url}`);
    graph.sends.push(body);
    if (graph.gate) await graph.gate;
    const failure = graph.failSend && graph.failSend(body, graph.sends.length);
    if (failure) throw failure;
    return { data: { recipient_id: body.recipient.id, message_id: `mid.remy.${++graph.n}` } };
  };
  graph.get = async (url, config) => {
    graph.calls.push({ method: "get", url, params: config.params });
    if (/\/me\/conversations$/.test(url)) {
      return {
        data: {
          data: [{ id: "aWdfZAG06conv1", updated_time: "2026-11-16T09:44:55+0000", participants: { data: [{ username: "cooknest.app", id: BOT_ID }, { username: "someone.test", id: USER }] } }],
          paging: { cursors: { after: "NEXT1" }, next: `https://graph.instagram.com/v20.0/me/conversations?access_token=${TOKEN}&after=NEXT1` },
        },
      };
    }
    if (/\/aWdfZAG06conv1\/messages$/.test(url)) return { data: messagesPage };
    if (/\/me$/.test(url)) return { data: { user_id: BOT_ID, username: "cooknest.app" } };
    if (new RegExp(`/${USER}$`).test(url)) {
      return { data: { name: "Some One", username: "someone.test", profile_pic: "https://cdn.test/p.jpg", follower_count: 42, is_verified_user: false, is_user_follow_business: true, is_business_follow_user: false } };
    }
    throw graphFailure(400, { message: "Unsupported get request.", code: 100, error_subcode: 33 });
  };
  return graph;
}

async function makeServer(t, { secret = SECRET, token = { access_token: TOKEN, expires_at: "2026-03-01T00:00:00.000Z" } } = {}) {
  const h = await makeHarness({ bridge: true });
  const graph = fakeGraph();
  const api = new InstagramAPI({
    http: graph,
    tokens: () => ({ getInstagramToken: async () => token }),
    notifier: { notifyTokenExpired: async () => {}, notifyError: async () => {} },
    accountId: () => BOT_ID,
    now: () => h.time.now(),
    logger: { log() {}, error() {} },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-media-"));
  const media = new MediaStore({ dir, publicBaseUrl: "https://bot.test/", clock: h.time, scheduler: h.time });
  const app = express();
  app.use("/internal/remy", createRemyRouter({ secret, api, store: h.store, responder: h.responder, media, bridge: h.remyBridge, accountId: BOT_ID, clock: h.time }));
  app.use("/internal-media", createMediaRouter({ secret, media }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, urlPath, body, { headers = {}, sign = true, signAt, rawBody } = {}) {
    const raw = rawBody ?? (body === undefined ? "" : JSON.stringify(body));
    const signature = sign ? signedHeaders(SECRET, raw, signAt ?? h.time.now()) : {};
    const response = await fetch(base + urlPath, {
      method,
      body: method === "GET" ? undefined : raw,
      headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...signature, ...headers },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch (_e) {
      json = null;
    }
    return { status: response.status, body: json, buffer, headers: response.headers };
  }
  return { h, graph, media, dir, call, base };
}

const b64 = (bytes, fill = 7) => Buffer.alloc(bytes, fill).toString("base64");

test("no REMY_BRIDGE_SECRET: every /internal/remy/* and /internal-media/* answers 404", async (t) => {
  const { call, graph } = await makeServer(t, { secret: "" });
  for (const [method, url, body] of [
    ["GET", "/internal/remy/health"],
    ["GET", `/internal/remy/profile/${USER}`],
    ["GET", "/internal/remy/conversations"],
    ["POST", "/internal/remy/send", { recipientId: USER, text: "Hola", idempotencyKey: "k" }],
    ["GET", `/internal-media/${"a".repeat(64)}.jpg`],
  ]) {
    assert.equal((await call(method, url, body)).status, 404, url);
  }
  assert.equal(graph.calls.length, 0);
});

test("signatures: good passes; bad, tampered, missing or 301 s off is 401", async (t) => {
  const { call, h } = await makeServer(t);
  assert.equal((await call("GET", "/internal/remy/health")).status, 200);
  assert.equal((await call("GET", "/internal/remy/health", undefined, { sign: false })).status, 401);
  assert.equal((await call("GET", "/internal/remy/health", undefined, { headers: { "X-Bridge-Signature": "sha256=" + "0".repeat(64) } })).status, 401);
  assert.equal((await call("GET", "/internal/remy/health", undefined, { signAt: h.time.now() - 301 * 1000 })).status, 401);
  assert.equal((await call("GET", "/internal/remy/health", undefined, { signAt: h.time.now() + 301 * 1000 })).status, 401);
  assert.equal((await call("GET", "/internal/remy/health", undefined, { signAt: h.time.now() - 299 * 1000 })).status, 200);

  // Signed for one body, sent with another
  const signed = signedHeaders(SECRET, JSON.stringify({ recipientId: USER, text: "a", idempotencyKey: "k" }), h.time.now());
  const tampered = await call("POST", "/internal/remy/send", undefined, {
    sign: false,
    headers: signed,
    rawBody: JSON.stringify({ recipientId: USER, text: "b", idempotencyKey: "k" }),
  });
  assert.equal(tampered.status, 401);
  assert.deepEqual(tampered.body, { error: { status: 401, message: "bad signature" } });
});

test("through Cloudflare (cf-connecting-ip / cf-ray): 403 even when signed, nothing sent", async (t) => {
  const { call, graph } = await makeServer(t);
  for (const header of [{ "cf-connecting-ip": "203.0.113.9" }, { "cf-ray": "8a1b2c3d4e5f-MAD" }]) {
    const res = await call("POST", "/internal/remy/send", { recipientId: USER, text: "Hola", idempotencyKey: `k-${Object.keys(header)[0]}` }, { headers: header });
    assert.equal(res.status, 403);
    assert.equal((await call("GET", "/internal/remy/health", undefined, { headers: header })).status, 403);
  }
  assert.equal(graph.sends.length, 0);
});

test("send text: Graph without tags, reply_to, mid recorded, lastHumanAt = now", async (t) => {
  const { call, graph, h } = await makeServer(t);
  await h.time.advanceBy(3 * MINUTE);
  const res = await call("POST", "/internal/remy/send", { recipientId: USER, text: "Hola, soy Carles", replyToMid: "aWdf.in.1", idempotencyKey: "send-1" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { messageIds: ["mid.remy.1"] });
  assert.deepEqual(graph.sends, [{ recipient: { id: USER }, message: { text: "Hola, soy Carles" }, reply_to: { mid: "aWdf.in.1" } }]);
  assert.equal(graph.calls[0].params.access_token, TOKEN);
  assert.equal(await h.store.isRemyMessage("mid.remy.1"), true);
  assert.equal((await h.store.getState(USER, "live", h.time.now())).lastHumanAt, h.time.now());

  // The bot now stays out of this conversation
  await h.reel(USER);
  await h.time.runAll();
  assert.equal(h.decisions.at(-1).action.reason, "human_recent");
  assert.equal(h.sent.length, 0);
});

test("idempotencyKey: a repeat or a concurrent duplicate gets the first answer, one send", async (t) => {
  const { call, graph, h } = await makeServer(t);
  const body = { recipientId: USER, text: "Una vez", idempotencyKey: "same" };
  const first = await call("POST", "/internal/remy/send", body);
  const again = await call("POST", "/internal/remy/send", body);
  assert.deepEqual(again, { ...again, status: first.status, body: first.body });
  assert.equal(graph.sends.length, 1);

  let release;
  graph.gate = new Promise((resolve) => (release = resolve));
  const concurrent = { recipientId: USER, text: "Dos a la vez", idempotencyKey: "concurrent" };
  const a = call("POST", "/internal/remy/send", concurrent);
  const b = call("POST", "/internal/remy/send", concurrent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  graph.gate = null;
  assert.deepEqual(ra.body, { messageIds: ["mid.remy.2"] });
  assert.deepEqual(rb.body, ra.body);
  assert.equal(graph.sends.length, 2);

  // Kept 24 h
  await h.time.advanceBy(23 * HOUR);
  assert.deepEqual((await call("POST", "/internal/remy/send", body)).body, first.body);
  assert.equal(graph.sends.length, 2);
});

test("text + file: two sends in order; the file is served for 1 h at an unguessable URL, then 404", async (t) => {
  const { call, graph, h, dir, base } = await makeServer(t);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 1)]);
  const res = await call("POST", "/internal/remy/send", {
    recipientId: USER,
    text: "Mira la foto",
    replyToMid: "aWdf.in.2",
    file: { filename: "plato.png", contentType: "image/png", dataBase64: png.toString("base64") },
    idempotencyKey: "with-file",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { messageIds: ["mid.remy.1", "mid.remy.2"] });
  assert.deepEqual(graph.sends[0], { recipient: { id: USER }, message: { text: "Mira la foto" }, reply_to: { mid: "aWdf.in.2" } });
  const attachment = graph.sends[1].message.attachment;
  assert.equal(attachment.type, "image");
  assert.equal(graph.sends[1].reply_to, undefined);
  const match = attachment.payload.url.match(/^https:\/\/bot\.test\/internal-media\/([0-9a-f]{64}\.png)$/);
  assert.ok(match, attachment.payload.url);
  assert.equal(await h.store.isRemyMessage("mid.remy.2"), true);

  const name = match[1];
  const fetchMedia = () => fetch(`${base}/internal-media/${name}`);
  await h.time.advanceBy(59 * MINUTE);
  const live = await fetchMedia();
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await live.arrayBuffer()), png);
  assert.ok(fs.existsSync(path.join(dir, name)));

  await h.time.advanceBy(1 * MINUTE);
  assert.equal((await fetchMedia()).status, 404);
  assert.equal(fs.existsSync(path.join(dir, name)), false, "deleted after 1 h");
  assert.equal((await fetch(`${base}/internal-media/${"0".repeat(64)}.png`)).status, 404);
  assert.equal((await fetch(`${base}/internal-media/..%2F..%2Fetc%2Fpasswd`)).status, 404);
});

test("file only, video and audio; wrong type or size: 422 with a clear reason, nothing sent", async (t) => {
  const { call, graph } = await makeServer(t);
  const send = (file, key) => call("POST", "/internal/remy/send", { recipientId: USER, file, idempotencyKey: key });

  const video = await send({ filename: "receta.mov", contentType: "video/quicktime", dataBase64: b64(1000) }, "v");
  assert.equal(video.status, 200);
  assert.equal(graph.sends.at(-1).message.attachment.type, "video");
  assert.match(graph.sends.at(-1).message.attachment.payload.url, /\.mov$/);
  const audio = await send({ filename: "nota.m4a", contentType: "audio/mp4", dataBase64: b64(1000) }, "a");
  assert.equal(audio.status, 200);
  assert.equal(graph.sends.at(-1).message.attachment.type, "audio");
  const sentSoFar = graph.sends.length;

  const cases = [
    [{ filename: "doc.pdf", contentType: "application/pdf", dataBase64: b64(10) }, /Instagram cannot send application\/pdf \(doc\.pdf\)/],
    [{ filename: "a.bmp", contentType: "image/bmp", dataBase64: b64(10) }, /cannot send image\/bmp/],
    [{ filename: "big.png", contentType: "image/png", dataBase64: b64(8 * 1024 * 1024 + 1) }, /big\.png is 8\.0 MB: Instagram takes images up to 8 MB/],
    [{ filename: "long.mp4", contentType: "video/mp4", dataBase64: b64(25 * 1024 * 1024 + 1) }, /long\.mp4 is 25\.0 MB: Instagram takes video up to 25 MB/],
    [{ filename: "empty.jpg", contentType: "image/jpeg", dataBase64: "" }, /empty\.jpg is empty/],
    [{ filename: "x.jpg", contentType: "image/jpeg", dataBase64: "not base64!!" }, /not valid base64/],
  ];
  for (const [i, [file, reason]] of cases.entries()) {
    const res = await send(file, `bad-${i}`);
    assert.equal(res.status, 422, file.filename);
    assert.equal(res.body.error.status, 422);
    assert.match(res.body.error.message, reason);
  }
  assert.equal(graph.sends.length, sentSoFar);
  assert.equal((await call("POST", "/internal/remy/send", { recipientId: USER, idempotencyKey: "nothing" })).status, 400);
  assert.equal((await call("POST", "/internal/remy/send", { recipientId: USER, text: "x" })).status, 400);
});

test("Graph's error comes back verbatim with its status; no lastHumanAt when nothing went", async (t) => {
  const { call, graph, h } = await makeServer(t);
  graph.failSend = () =>
    graphFailure(400, { message: "This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2534022, fbtrace_id: "AbC" });
  const res = await call("POST", "/internal/remy/send", { recipientId: USER, text: "Hola", idempotencyKey: "window" });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: { status: 400, code: 10, subcode: 2534022, message: "This message is sent outside of allowed window." } });
  assert.equal((await h.store.getState(USER, "live", h.time.now())).lastHumanAt, null);

  // Text went, file failed: the error says which mid did go
  graph.failSend = (body) => (body.message.attachment ? graphFailure(500, { message: "An unknown error occurred", code: 1, error_subcode: 99 }) : null);
  const partial = await call("POST", "/internal/remy/send", {
    recipientId: USER,
    text: "Texto",
    file: { filename: "a.jpg", contentType: "image/jpeg", dataBase64: b64(100) },
    idempotencyKey: "partial",
  });
  assert.equal(partial.status, 500);
  assert.deepEqual(partial.body, { error: { status: 500, code: 1, subcode: 99, message: "An unknown error occurred" }, messageIds: ["mid.remy.1"] });
});

test("an echo arriving before Graph answers Remy's send is forwarded as remy", async (t) => {
  const { call, graph, h } = await makeServer(t);
  let release;
  graph.gate = new Promise((resolve) => (release = resolve));
  const sending = call("POST", "/internal/remy/send", { recipientId: USER, text: "Hola desde Remy", idempotencyKey: "race" });
  while (graph.sends.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const echo = h.echo(USER, "mid.remy.1", "Hola desde Remy"); // the webhook beats Graph's answer
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([sending, echo]);
  const forwarded = await h.forwarded();
  assert.deepEqual(forwarded.map((e) => [e.id, e.origin]), [["mid.remy.1", "remy"]]);
});

test("profile: Remy's shape with profilePic, cached 24 h", async (t) => {
  const { call, graph, h } = await makeServer(t);
  const res = await call("GET", `/internal/remy/profile/${USER}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    igsid: USER,
    username: "someone.test",
    name: "Some One",
    followerCount: 42,
    isVerifiedUser: false,
    isUserFollowBusiness: true,
    isBusinessFollowUser: false,
    profilePic: "https://cdn.test/p.jpg",
  });
  await h.time.advanceBy(23 * HOUR);
  assert.deepEqual((await call("GET", `/internal/remy/profile/${USER}`)).body, res.body);
  assert.equal(graph.calls.filter((c) => c.url.endsWith(`/${USER}`)).length, 1);
  const failed = await call("GET", "/internal/remy/profile/123");
  assert.deepEqual(failed.body, { error: { status: 400, code: 100, subcode: 33, message: "Unsupported get request." } });
  assert.equal((await call("GET", "/internal/remy/profile/not-an-id")).status, 400);
});

test("conversations and messages: shapes, cursors, no token anywhere", async (t) => {
  const { call, graph } = await makeServer(t);
  const conversations = await call("GET", "/internal/remy/conversations");
  assert.deepEqual(conversations.body, {
    data: [{ id: "aWdfZAG06conv1", updatedTime: "2026-11-16T09:44:55+0000", participants: [{ id: BOT_ID, username: "cooknest.app" }, { id: USER, username: "someone.test" }] }],
    next: "NEXT1",
  });
  await call("GET", "/internal/remy/conversations?after=NEXT1");
  assert.equal(graph.calls.at(-1).params.after, "NEXT1");

  const messages = await call("GET", "/internal/remy/conversations/aWdfZAG06conv1/messages?after=C1");
  assert.equal(messages.status, 200);
  assert.equal(graph.calls.at(-1).params.after, "C1");
  assert.equal(messages.body.next, "QVFIUnextcursor");
  assert.deepEqual(Object.keys(messages.body.data[0]).sort(), ["created_time", "from", "id", "is_unsupported", "message", "to"]);
  assert.ok(!JSON.stringify([conversations.body, messages.body]).includes(TOKEN));
  assert.ok(!JSON.stringify(messages.body).includes("access_token"));
});

test("health: {ok, tokenExpiresAt, igUserId, username, forward}, no secrets", async (t) => {
  const { call, h } = await makeServer(t);
  await h.text(USER, "Hola"); // one event waiting in the outbox
  await h.remyBridge.settled();
  const res = await call("GET", "/internal/remy/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    tokenExpiresAt: "2026-03-01T00:00:00.000Z",
    igUserId: BOT_ID,
    username: "cooknest.app",
    forward: { queued: 1, oldestAt: new Date(h.time.now()).toISOString(), lastOkAt: null, lastError: null },
  });
  assert.ok(!res.buffer.toString().includes(TOKEN) && !res.buffer.toString().includes(SECRET));

  await h.forwarded();
  const after = (await call("GET", "/internal/remy/health")).body.forward;
  assert.deepEqual(after, { queued: 0, oldestAt: null, lastOkAt: new Date(h.time.now()).toISOString(), lastError: null });
});

test("health with an expired token: ok false", async (t) => {
  const { call } = await makeServer(t, { token: { access_token: TOKEN, expires_at: "2025-12-01T00:00:00.000Z" } });
  const res = await call("GET", "/internal/remy/health");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.tokenExpiresAt, "2025-12-01T00:00:00.000Z");
  assert.equal(res.body.username, null);
});
