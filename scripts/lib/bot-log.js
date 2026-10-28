// Parser for the production bot log (logs/bot.log).
// Entries start with "[YYYY-MM-DD HH:MM:SS.mmm] " (UTC); a quoted message text
// can span several lines, so lines without a timestamp continue the previous entry.

const ENTRY_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] ([\s\S]*)$/;
const USER_RE = /^User (\d+) sent message "([\s\S]*)"$/;
const OURS_RE = /^(Automatic|Manual) message sent by us to (\d+): "([\s\S]*)"$/;
const ACK_DEBUG_RE = /^ACK Debug - User: (\d+),/;

function parseTimestamp(ts) {
  return Date.parse(ts.replace(" ", "T") + "Z");
}

function readEntries(content) {
  const entries = [];
  for (const line of content.split("\n")) {
    const match = line.match(ENTRY_RE);
    if (match) {
      entries.push({ at: parseTimestamp(match[1]), raw: match[2] });
    } else if (entries.length > 0) {
      entries[entries.length - 1].raw += "\n" + line;
    }
  }
  for (const entry of entries) {
    entry.raw = entry.raw.replace(/\n+$/, "");
  }
  return entries;
}

/**
 * Parses the log into user messages and messages sent by us.
 * Each user message gets `oldBranch`: "reel" when the old bot handled it as a
 * reel/link, "other" when it went to the non-reel branch (which always logs an
 * ACK line right after).
 * @returns {Array<{type:"user"|"automatic"|"manual", at:number, userId:string, text:string, oldBranch?:string}>}
 */
function parseBotLog(content) {
  const entries = readEntries(content);
  const events = [];

  for (let i = 0; i < entries.length; i++) {
    const { at, raw } = entries[i];
    const user = raw.match(USER_RE);
    if (user) {
      events.push({
        type: "user",
        at,
        userId: user[1],
        text: user[2],
        oldBranch: findOldBranch(entries, i, user[1]),
      });
      continue;
    }
    const ours = raw.match(OURS_RE);
    if (ours) {
      events.push({
        type: ours[1] === "Automatic" ? "automatic" : "manual",
        at,
        userId: ours[2],
        text: ours[3],
      });
    }
  }
  return events;
}

function findOldBranch(entries, index, userId) {
  const start = entries[index].at;
  for (let j = index + 1; j < entries.length; j++) {
    const { at, raw } = entries[j];
    if (at - start > 10000) break;
    if (raw.startsWith("User ")) break;
    if (raw === "ACK disabled in config") return "other";
    const ack = raw.match(ACK_DEBUG_RE);
    if (ack && ack[1] === userId) return "other";
  }
  return "reel";
}

module.exports = { parseBotLog, readEntries };
