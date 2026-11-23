// splitflap lite — a minimal relay between one board screen and any number of phones.
//
//   board  ──hello{code?,cols,rows}──▶  server  ──code{code,text,align}──▶ board
//   phone  ──join{code}────────────────▶ server  ──joined{cols,rows,text}─▶ phone
//   phone  ──show{text,align}──────────▶ server  ──show──────────────────▶ board
//   phone  ──config{cols,rows}─────────▶ server  ──config────────────────▶ board
//   board  ──size{cols,rows}───────────▶ server  ──size──────────────────▶ phones
//
// The server keeps the last text per board, so a board that reloads or
// reconnects shows the same message again.

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TEXT = 2000;
const IDLE_TTL = 6 * 60 * 60 * 1000; // forget boards that have been offline for 6h

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_, res) => res.json({ ok: true, boards: boards.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

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
          rec = { board: null, phones: new Set(), text: "", align: "left" };
          boards.set(code, rec);
        }
        rec.board = ws;
        rec.cols = cleanSize(msg.cols, 4, 40, 22);
        rec.rows = cleanSize(msg.rows, 1, 12, 6);
        rec.seen = Date.now();
        ws.role = "board";
        ws.code = code;
        send(ws, { type: "code", code, text: rec.text, align: rec.align, phones: rec.phones.size });
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
        rec.seen = Date.now();
        send(rec.board, { type: "show", text: rec.text, align: rec.align });
        for (const p of rec.phones) if (p !== ws) send(p, { type: "text", text: rec.text, align: rec.align });
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
  console.log(`splitflap lite on http://localhost:${PORT}`);
  console.log(`  Board: http://localhost:${PORT}/            Phone: http://localhost:${PORT}/phone.html`);
});
