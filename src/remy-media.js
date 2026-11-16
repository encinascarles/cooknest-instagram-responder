// Files Remy sends: Graph only takes attachments by URL, so each file is written
// to a temp dir and served at GET /internal-media/<64 hex chars>.<ext> (public,
// unguessable name) for 1 hour, then deleted (timer + sweep).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR = 60 * 60 * 1000;
const MB = 1024 * 1024;
const NAME_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,5}$/;

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov" };
const AUDIO_EXTENSIONS = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};
const LIMITS = { image: 8 * MB, video: 25 * MB, audio: 25 * MB };

const ACCEPTED = "images (JPEG, PNG, GIF, WebP, up to 8 MB), videos (MP4, MOV, up to 25 MB) and audio (up to 25 MB)";

function formatMb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Which Instagram attachment a file becomes.
 * @returns {{ok: true, type: "image"|"video"|"audio", ext: string, contentType: string}
 *   | {ok: false, message: string}}
 */
function classifyFile({ filename, contentType, size }) {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  let kind = null;
  let ext = null;
  if (IMAGE_TYPES[type]) [kind, ext] = ["image", IMAGE_TYPES[type]];
  else if (VIDEO_TYPES[type]) [kind, ext] = ["video", VIDEO_TYPES[type]];
  else if (/^audio\/[\w.+-]+$/.test(type)) {
    kind = "audio";
    const fromName = path.extname(String(filename || "")).slice(1).toLowerCase();
    ext = AUDIO_EXTENSIONS[type] || (/^[a-z0-9]{1,5}$/.test(fromName) ? fromName : "audio");
  }
  if (!kind) {
    return { ok: false, message: `Instagram cannot send ${type || "a file without a content type"} (${filename || "file"}): it takes ${ACCEPTED}.` };
  }
  if (!size) return { ok: false, message: `${filename || "The file"} is empty.` };
  if (size > LIMITS[kind]) {
    return { ok: false, message: `${filename || "The file"} is ${formatMb(size)}: Instagram takes ${kind === "image" ? "images" : kind} up to ${LIMITS[kind] / MB} MB.` };
  }
  return { ok: true, type: kind, ext, contentType: type };
}

class MediaStore {
  /**
   * @param {object} deps
   * @param {string} [deps.dir] REMY_MEDIA_DIR, default <tmp>/cooknest-remy-media
   * @param {string} deps.publicBaseUrl PUBLIC_BASE_URL
   * @param {{now: () => number}} [deps.clock]
   * @param {{setTimeout: (fn: Function, ms: number) => any}} [deps.scheduler]
   * @param {number} [deps.ttlMs] 1 hour
   */
  constructor({ dir, publicBaseUrl, clock, scheduler, ttlMs = HOUR }) {
    this.dir = path.resolve(dir || path.join(os.tmpdir(), "cooknest-remy-media"));
    this.publicBaseUrl = String(publicBaseUrl || "").replace(/\/+$/, "");
    this.clock = clock || { now: () => Date.now() };
    this.scheduler = scheduler || { setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
    this.ttlMs = ttlMs;
    this.files = new Map(); // name -> {file, contentType, expiresAt}
    this.ready = this.init();
  }

  // Files left by an earlier run have lost their timers: delete them
  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const name of await fs.promises.readdir(this.dir)) {
      if (NAME_RE.test(name)) await fs.promises.rm(path.join(this.dir, name), { force: true });
    }
  }

  /**
   * @returns {Promise<{name: string, url: string, expiresAt: number}>}
   */
  async put(buffer, { ext, contentType }) {
    await this.ready;
    const name = `${crypto.randomBytes(32).toString("hex")}.${ext}`;
    const file = path.join(this.dir, name);
    await fs.promises.writeFile(file, buffer, { mode: 0o600 });
    const expiresAt = this.clock.now() + this.ttlMs;
    this.files.set(name, { file, contentType, expiresAt });
    this.scheduler.setTimeout(() => this.remove(name), this.ttlMs);
    return { name, url: `${this.publicBaseUrl}/internal-media/${name}`, expiresAt };
  }

  // {file, contentType} while the file is live, else null
  lookup(name) {
    if (!NAME_RE.test(String(name))) return null;
    const entry = this.files.get(name);
    if (!entry) return null;
    if (this.clock.now() >= entry.expiresAt) {
      this.remove(name);
      return null;
    }
    return entry;
  }

  async remove(name) {
    const entry = this.files.get(name);
    if (!entry) return;
    this.files.delete(name);
    await fs.promises.rm(entry.file, { force: true }).catch(() => {});
  }

  async sweep() {
    const now = this.clock.now();
    for (const [name, entry] of [...this.files]) {
      if (now >= entry.expiresAt) await this.remove(name);
    }
  }
}

module.exports = { MediaStore, classifyFile, NAME_RE, LIMITS };
