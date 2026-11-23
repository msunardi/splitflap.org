// splitflap lite — a minimal relay between one board screen and any number of phones.
//
//   board  ──hello{code?,cols,rows}──▶  server  ──code{code,text,align}──▶ board
//   phone  ──join{code}────────────────▶ server  ──joined{cols,rows,text}─▶ phone
//   phone  ──show{text,align}──────────▶ server  ──show──────────────────▶ board
//   phone  ──config{cols,rows}─────────▶ server  ──config────────────────▶ board
//   board  ──size{cols,rows}───────────▶ server  ──size──────────────────▶ phones
//   phone  ──widgets{widgets}──────────▶ server  ──widgets───────────────▶ board + other phones
//   phone  ──mode{"message"|"widgets"}─▶ server  ──mode──────────────────▶ board + other phones
//   phone  ──calendar{url}─────────────▶ server  (keeps the URL, fetches the feed every 5 min)
//                                        server  ──calendar{events,status}─▶ board + phones
//
// HTTP: /api/weather?lat&lon&unit (Open-Meteo, falling back to weather.gov
// for US locations) and /api/geocode?q (Open-Meteo city search).
//
// The server keeps the last text per board, so a board that reloads or
// reconnects shows the same message again.

const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const calendar = require("./calendar");

const PORT = process.env.PORT || 3001;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TEXT = 2000;
const IDLE_TTL = 6 * 60 * 60 * 1000; // forget boards that have been offline for 6h

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_, res) => res.json({ ok: true, boards: boards.size }));

// ── Weather ─────────────────────────────────────────────────────────
const WX_TTL = 10 * 60 * 1000;
const wxCache = new Map();      // "lat,lon,unit" -> { at, data }
const pointCache = new Map();   // "lat,lon" -> weather.gov forecast URLs
const UA = { "User-Agent": "splitflap-lite weather widget", Accept: "application/geo+json, application/json" };

async function getJson(url, ms = 7000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// WMO weather codes used by Open-Meteo -> [long, short]
const WMO = [
  [[0], "CLEAR", "CLEAR"], [[1], "MOSTLY CLEAR", "CLEAR"], [[2], "PARTLY CLOUDY", "PT CLOUDY"],
  [[3], "CLOUDY", "CLOUDY"], [[45, 48], "FOG", "FOG"], [[51, 53, 55, 56, 57], "DRIZZLE", "DRIZZLE"],
  [[61, 63, 65, 66, 67], "RAIN", "RAIN"], [[71, 73, 75, 77], "SNOW", "SNOW"],
  [[80, 81, 82], "RAIN SHOWERS", "SHOWERS"], [[85, 86], "SNOW SHOWERS", "SNOW"],
  [[95, 96, 99], "THUNDERSTORMS", "T-STORMS"],
];
const wmoText = (code) => WMO.find(([codes]) => codes.includes(code))?.slice(1) || ["", ""];

async function openMeteo(lat, lon, unit) {
  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=${unit === "C" ? "celsius" : "fahrenheit"}&timezone=auto&forecast_days=1`);
  const [desc, short] = wmoText(j.current?.weather_code);
  return {
    temp: Math.round(j.current.temperature_2m), desc, short,
    hi: Math.round(j.daily.temperature_2m_max[0]), lo: Math.round(j.daily.temperature_2m_min[0]),
    source: "open-meteo",
  };
}

async function weatherGov(lat, lon, unit) {
  const key = `${lat},${lon}`;
  let pt = pointCache.get(key);
  if (!pt) {
    const p = await getJson(`https://api.weather.gov/points/${lat},${lon}`);
    pt = { daily: p.properties.forecast, hourly: p.properties.forecastHourly };
    pointCache.set(key, pt);
  }
  const units = unit === "C" ? "si" : "us";
  const [hourly, daily] = await Promise.all([getJson(`${pt.hourly}?units=${units}`), getJson(`${pt.daily}?units=${units}`)]);
  const now = hourly.properties.periods[0];
  const periods = daily.properties.periods;
  const day = periods.find((p) => p.isDaytime), night = periods.find((p) => !p.isDaytime);
  const desc = String(now.shortForecast || "").split(" then ")[0];
  return {
    temp: Math.round(now.temperature), desc,
    short: desc.replace(/^(Slight Chance|Chance|Likely|Mostly|Partly)\s+/i, ""),
    hi: day ? Math.round(day.temperature) : null, lo: night ? Math.round(night.temperature) : null,
    source: "weather.gov",
  };
}

app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ ok: false, error: "Bad coordinates" });
  const unit = req.query.unit === "C" ? "C" : "F";
  const la = lat.toFixed(4), lo = lon.toFixed(4), key = `${la},${lo},${unit}`;
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.at < WX_TTL) return res.json({ ok: true, ...hit.data });
  const errors = [];
  for (const provider of [openMeteo, weatherGov]) {
    try {
      const data = await provider(la, lo, unit);
      wxCache.set(key, { at: Date.now(), data });
      return res.json({ ok: true, ...data });
    } catch (e) {
      errors.push(`${provider.name}: ${e.cause?.code || e.message}`);
    }
  }
  if (hit) return res.json({ ok: true, stale: true, ...hit.data }); // better old than nothing
  res.status(502).json({ ok: false, error: errors.join("; ") });
});

app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, results: [] });
  try {
    const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
    res.json({
      ok: true,
      results: (j.results || []).map((r) => ({
        name: [r.name, r.admin1, r.country_code].filter(Boolean).join(", "),
        lat: +r.latitude.toFixed(4), lon: +r.longitude.toFixed(4),
      })),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.cause?.code || e.message });
  }
});

// HTTPS is optional. Browsers only allow "Use my location" on secure pages
// (HTTPS, or localhost), so to use it from a phone on your network, put a
// certificate in lite/certs/ (cert.pem + key.pem) or point SSL_CERT /
// SSL_KEY at one. See lite/README.md.
const CERT = process.env.SSL_CERT || path.join(__dirname, "certs", "cert.pem");
const KEY = process.env.SSL_KEY || path.join(__dirname, "certs", "key.pem");
const useHttps = fs.existsSync(CERT) && fs.existsSync(KEY);
const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
  : http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

/** code -> { board: ws|null, phones: Set<ws>, text, align, cols, rows, seen } */
const boards = new Map();

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  } while (boards.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function toPhones(rec, obj) {
  for (const p of rec.phones) send(p, obj);
}

const cleanCode = (v) => (typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) : "");
const cleanSize = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const cleanAlign = (v) => (v === "center" ? "center" : "left");
const cleanMode = (v) => (v === "widgets" ? "widgets" : "message");
const WIDGET_IDS = ["clock", "schedule", "weather", "notes"];
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

// Accept only the known widget fields, with sane sizes.
function cleanWidgets(w) {
  if (!w || typeof w !== "object") return null;
  const order = [...new Set((Array.isArray(w.order) ? w.order : []).filter((id) => WIDGET_IDS.includes(id)))];
  for (const id of WIDGET_IDS) if (!order.includes(id)) order.push(id);
  const on = Object.fromEntries(WIDGET_IDS.map((id) => [id, w.on?.[id] !== false]));
  const items = (Array.isArray(w.schedule?.items) ? w.schedule.items : []).slice(0, 50)
    .map((i) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(i?.date) ? i.date : "",
      time: /^\d{2}:\d{2}$/.test(i?.time) ? i.time : "",
      title: str(i?.title, 80),
    }))
    .filter((i) => i.date && i.time);
  const wx = w.weather || {};
  const lat = Number(wx.lat), lon = Number(wx.lon);
  const hasLoc = wx.lat != null && wx.lat !== "" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    order, on,
    clock: { h24: !!w.clock?.h24 },
    schedule: { items },
    weather: { lat: hasLoc ? +lat.toFixed(4) : null, lon: hasLoc ? +lon.toFixed(4) : null, name: str(wx.name, 80), unit: wx.unit === "C" ? "C" : "F" },
    notes: { text: str(w.notes?.text, 300) },
    align: cleanAlign(w.align),
  };
}

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "hello": {
        // A board connects. Reuse its old code if it is reconnecting.
        let code = cleanCode(msg.code);
        let rec = boards.get(code);
        if (!rec || (rec.board && rec.board !== ws && rec.board.readyState === 1)) {
          code = newCode();
          rec = { board: null, phones: new Set(), text: "", align: "left", mode: "message", widgets: null, cal: newCal() };
          boards.set(code, rec);
        }
        rec.board = ws;
        rec.cols = cleanSize(msg.cols, 4, 40, 22);
        rec.rows = cleanSize(msg.rows, 1, 12, 6);
        rec.seen = Date.now();
        ws.role = "board";
        ws.code = code;
        send(ws, { type: "code", code, text: rec.text, align: rec.align, mode: rec.mode, widgets: rec.widgets, phones: rec.phones.size, calendar: calPayload(rec) });
        toPhones(rec, { type: "board_online", cols: rec.cols, rows: rec.rows });
        break;
      }

      case "join": {
        // A phone pairs using the code shown on the board.
        const code = cleanCode(msg.code);
        const rec = boards.get(code);
        if (!rec) return send(ws, { type: "error", message: "No board with that code" });
        if (ws.code && ws.code !== code) boards.get(ws.code)?.phones.delete(ws);
        rec.phones.add(ws);
        ws.role = "phone";
        ws.code = code;
        send(ws, {
          type: "joined",
          code,
          online: !!(rec.board && rec.board.readyState === 1),
          cols: rec.cols,
          rows: rec.rows,
          text: rec.text,
          align: rec.align,
          mode: rec.mode,
          widgets: rec.widgets,
          calendar: calPayload(rec),
        });
        send(rec.board, { type: "phones", count: rec.phones.size });
        break;
      }

      case "show": {
        // Phone (or the board's own test box) sets the text.
        const rec = boards.get(ws.code);
        if (!rec || typeof msg.text !== "string") return;
        rec.text = msg.text.slice(0, MAX_TEXT);
        rec.align = cleanAlign(msg.align);
        rec.mode = "message";
        rec.seen = Date.now();
        send(rec.board, { type: "show", text: rec.text, align: rec.align });
        for (const p of rec.phones) if (p !== ws) send(p, { type: "text", text: rec.text, align: rec.align });
        toPhones(rec, { type: "mode", mode: rec.mode });
        break;
      }

      case "widgets": {
        const rec = boards.get(ws.code);
        const widgets = cleanWidgets(msg.widgets);
        if (!rec || !widgets) return;
        rec.widgets = widgets;
        rec.seen = Date.now();
        send(rec.board, { type: "widgets", widgets });
        for (const p of rec.phones) if (p !== ws) send(p, { type: "widgets", widgets });
        break;
      }

      case "mode": {
        const rec = boards.get(ws.code);
        if (!rec) return;
        rec.mode = cleanMode(msg.mode);
        send(rec.board, { type: "mode", mode: rec.mode });
        toPhones(rec, { type: "mode", mode: rec.mode });
        break;
      }

      case "calendar": {
        // Phone connects (url) or disconnects (empty url) a Google Calendar feed.
        if (ws.role !== "phone") return;
        const rec = boards.get(ws.code);
        if (!rec) return;
        const raw = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!raw) {
          if (rec.cal.url) calendar.forget(rec.cal.url);
          rec.cal = newCal();
          broadcastCal(rec);
          return;
        }
        let url;
        try {
          url = calendar.cleanCalendarUrl(raw);
        } catch (e) {
          return send(ws, { type: "calendar_error", message: e.message });
        }
        rec.cal = { ...newCal(), url, label: calendar.describeUrl(url), syncing: true };
        broadcastCal(rec);
        syncCalendar(rec, true);
        break;
      }

      case "config": {
        if (ws.role !== "phone") return;
        const rec = boards.get(ws.code);
        if (!rec) return;
        send(rec.board, {
          type: "config",
          cols: cleanSize(msg.cols, 4, 40, rec.cols),
          rows: cleanSize(msg.rows, 1, 12, rec.rows),
        });
        break;
      }

      case "size": {
        // Board reports its grid size after a change.
        if (ws.role !== "board") return;
        const rec = boards.get(ws.code);
        if (!rec) return;
        rec.cols = cleanSize(msg.cols, 4, 40, rec.cols);
        rec.rows = cleanSize(msg.rows, 1, 12, rec.rows);
        toPhones(rec, { type: "size", cols: rec.cols, rows: rec.rows });
        break;
      }
    }
  });

  ws.on("close", () => {
    const rec = boards.get(ws.code);
    if (!rec) return;
    if (ws.role === "board" && rec.board === ws) {
      rec.board = null;
      rec.seen = Date.now();
      toPhones(rec, { type: "board_offline" });
    }
    if (ws.role === "phone") {
      rec.phones.delete(ws);
      send(rec.board, { type: "phones", count: rec.phones.size });
    }
  });
  ws.on("error", () => {});
});

// ── Calendar sync ───────────────────────────────────────────────────
function newCal() {
  return { url: "", label: "", events: [], ok: false, error: "", syncedAt: null, syncing: false, tried: 0 };
}
// What phones and the board get: never the URL itself.
function calPayload(rec) {
  const c = rec.cal || newCal();
  return {
    events: c.events,
    status: { connected: !!c.url, label: c.label, ok: c.ok, error: c.error, syncedAt: c.syncedAt, syncing: c.syncing },
  };
}
function broadcastCal(rec) {
  const p = { type: "calendar", ...calPayload(rec) };
  send(rec.board, p);
  toPhones(rec, p);
}
async function syncCalendar(rec, force = false) {
  const c = rec.cal;
  if (!c.url) return;
  c.tried = Date.now();
  try {
    const events = await calendar.getEvents(c.url, { force });
    if (rec.cal !== c) return;            // disconnected or replaced meanwhile
    Object.assign(c, { events, ok: true, error: "", syncedAt: new Date().toISOString() });
  } catch (e) {
    if (rec.cal !== c) return;
    const why = e.name === "TimeoutError" ? "Google Calendar didn't answer in time." : e.cause?.code ? `Couldn't reach Google Calendar (${e.cause.code}).` : e.message;
    Object.assign(c, { ok: false, error: why });  // keep the last good events
  }
  c.syncing = false;
  broadcastCal(rec);
}
// Refresh connected calendars every 5 minutes while someone is watching
// (every minute after a failure).
setInterval(() => {
  const now = Date.now();
  for (const rec of boards.values()) {
    const c = rec.cal;
    if (!c?.url || c.syncing || (!rec.board && rec.phones.size === 0)) continue;
    if (now - c.tried >= (c.ok ? calendar.TTL : 60 * 1000)) syncCalendar(rec);
  }
}, 30 * 1000).unref();

// Heartbeat + cleanup of boards that have been gone a long time.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      ws.ping();
    }
  }
  const now = Date.now();
  for (const [code, rec] of boards) {
    if (!rec.board && rec.phones.size === 0 && now - rec.seen > IDLE_TTL) boards.delete(code);
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  const proto = useHttps ? "https" : "http";
  console.log(`splitflap lite on ${proto}://localhost:${PORT}${useHttps ? "  (HTTPS: certificate from " + CERT + ")" : ""}`);
  console.log(`  Board: ${proto}://localhost:${PORT}/            Phone: ${proto}://<this computer's IP>:${PORT}/phone.html`);
});
