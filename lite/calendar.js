// Reads a Google Calendar "Secret address in iCal format" feed and returns
// the events around today, with repeating events expanded.
//
// The feed URL works like a password (anyone with it can read the calendar),
// so it stays on the server: phones only ever see a shortened form, and the
// board only receives event times and titles.

const ical = require("node-ical");

// Only Google Calendar feeds by default. Tests point these at a local server.
const HOSTS = (process.env.CALENDAR_HOSTS || "calendar.google.com").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW_HTTP = process.env.CALENDAR_ALLOW_HTTP === "1";

const TTL = 5 * 60 * 1000;          // refetch a feed at most every 5 minutes
const MAX_BYTES = 5 * 1024 * 1024;  // refuse absurdly large feeds
const cache = new Map();            // url -> { at, events, pending }

/** Returns a normalized feed URL, or throws an Error with a message for the phone. */
function cleanCalendarUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new Error("That isn't a web address. Paste the whole link, starting with https://");
  }
  if (!(u.protocol === "https:" || (ALLOW_HTTP && u.protocol === "http:")))
    throw new Error("The link should start with https://");
  if (!HOSTS.includes(u.hostname))
    throw new Error("That isn't a Google Calendar link. Use the \"Secret address in iCal format\" from Google Calendar's settings.");
  if (!/\/basic\.ics$/i.test(u.pathname) && !/\.ics$/i.test(u.pathname))
    throw new Error("That's a Google Calendar link, but not the iCal one. Copy the \"Secret address in iCal format\" (it ends in basic.ics).");
  return u.toString();
}

/** Short, non-secret description of a feed URL for display. */
function describeUrl(url) {
  const u = new URL(url);
  const id = decodeURIComponent(u.pathname.split("/")[3] || "");
  return id ? `${id} (Google Calendar)` : u.hostname;
}

const text = (v) => (v && typeof v === "object" ? v.val : v) || "";

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "splitflap-lite calendar" } });
  if (r.status === 404) throw new Error("Google says this link doesn't exist. It may have been reset; copy the secret address again.");
  if (r.status === 401 || r.status === 403) throw new Error("Google refused this link. Copy the secret address again.");
  if (!r.ok) throw new Error(`Google Calendar answered with error ${r.status}`);
  const body = await r.text();
  if (body.length > MAX_BYTES) throw new Error("This calendar is too large to read.");
  if (!body.includes("BEGIN:VCALENDAR")) throw new Error("That link didn't return a calendar.");
  return body;
}

// Events from 1.5 days ago to 2.5 days ahead, so that "today" is covered in
// any timezone; the board picks out its own today.
function eventsAround(body, now = Date.now()) {
  const from = new Date(now - 36 * 3600e3), to = new Date(now + 60 * 3600e3);
  const out = [];
  for (const ev of Object.values(ical.sync.parseICS(body))) {
    if (!ev || ev.type !== "VEVENT" || ev.status === "CANCELLED") continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to });
    } catch {
      continue; // one broken event shouldn't hide the rest
    }
    for (const i of instances) {
      if (!i.start || i.event?.status === "CANCELLED") continue;
      out.push({
        start: new Date(i.start).toISOString(),
        allDay: !!i.isFullDay,
        title: String(text(i.summary) || "Busy").replace(/\s+/g, " ").trim().slice(0, 80),
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 300);
}

/** Events for a feed, from cache when fresh. Throws on failure. */
async function getEvents(url, { force = false } = {}) {
  const hit = cache.get(url);
  if (hit?.pending) return hit.pending;
  if (!force && hit && Date.now() - hit.at < TTL) return hit.events;
  const pending = download(url).then((body) => {
    const events = eventsAround(body);
    cache.set(url, { at: Date.now(), events });
    return events;
  });
  cache.set(url, { ...(hit || {}), pending });
  try {
    return await pending;
  } finally {
    const cur = cache.get(url);
    if (cur?.pending === pending) delete cur.pending;
  }
}

function forget(url) {
  cache.delete(url);
}

module.exports = { cleanCalendarUrl, describeUrl, getEvents, eventsAround, forget, TTL };
