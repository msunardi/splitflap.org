// Shared by board and phone so the phone preview matches the board exactly.
// Everything counts characters by code point (Array.from), never .length,
// so colour tiles like 🟥 take one cell and are never cut in half.
(function (global) {
  const SPOOL = Array.from(" ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*()-+=:;',./?");
  const COLORS = {
    "🟥": "#d93a2b", "🟧": "#ef7d1a", "🟨": "#f2c21b", "🟩": "#2f9e44",
    "🟦": "#1c6fd1", "🟪": "#7b3fbf", "⬜": "#f1f1f1",
  };

  const chars = (s) => Array.from(String(s || "").normalize("NFC").replace(/[️‍\r\t]/g, ""));

  // Split one typed line into lines no wider than cols.
  // Lines that already fit are kept as typed (spacing preserved).
  function wrapLine(line, cols) {
    const all = chars(line);
    if (all.length <= cols) return [all];
    const out = [];
    let cur = [];
    for (const word of line.split(/ +/).filter(Boolean).map(chars)) {
      let w = word;
      while (w.length > cols) {            // hard-break words longer than a row
        if (cur.length) { out.push(cur); cur = []; }
        out.push(w.slice(0, cols));
        w = w.slice(cols);
      }
      if (!w.length) continue;
      if (cur.length && cur.length + 1 + w.length > cols) { out.push(cur); cur = []; }
      cur = cur.length ? [...cur, " ", ...w] : w;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** text -> { grid: string[cols*rows], lines: string[][], overflow: boolean } */
  function layout(text, cols, rows, align) {
    let lines = [];
    for (const raw of String(text || "").toUpperCase().split("\n")) lines.push(...wrapLine(raw, cols));
    if (align === "center") {
      while (lines.length && !lines[lines.length - 1].join("").trim()) lines.pop();
      while (lines.length && !lines[0].join("").trim()) lines.shift();
    }
    const overflow = lines.length > rows;
    lines = lines.slice(0, rows);
    const top = align === "center" ? Math.floor((rows - lines.length) / 2) : 0;
    const grid = Array(cols * rows).fill(" ");
    lines.forEach((line, r) => {
      let cells = line;
      if (align === "center") {
        cells = chars(line.join("").trim());
        cells = [...Array(Math.floor((cols - cells.length) / 2)).fill(" "), ...cells];
      }
      cells.slice(0, cols).forEach((ch, c) => (grid[(top + r) * cols + c] = ch));
    });
    return { grid, lines, overflow };
  }

  // ── Widgets ──────────────────────────────────────────────────────
  // Each widget turns its settings into 0–2 rows of text no wider than
  // cols. The board stacks enabled widgets in `order`, top to bottom.
  const WIDGETS = {
    clock: { name: "Date & time", maxRows: 1 },
    schedule: { name: "Next in today's schedule", maxRows: 2 },
    weather: { name: "Weather", maxRows: 1 },
    notes: { name: "Notes", maxRows: 2 },
  };
  const WIDGET_IDS = Object.keys(WIDGETS);

  function defaultWidgets() {
    return {
      order: [...WIDGET_IDS],
      on: { clock: true, schedule: true, weather: true, notes: true },
      clock: { h24: false },
      schedule: { items: [] },               // { date: "YYYY-MM-DD", time: "HH:MM", title }
      weather: { lat: null, lon: null, name: "", unit: "F" },
      notes: { text: "" },
      align: "left",
    };
  }

  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  function fmtTime(h, m, h24, compact) {
    if (h24) return `${pad2(h)}:${pad2(m)}`;
    const ap = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${pad2(m)}${compact ? ap[0] : " " + ap}`;
  }
  // First candidate that fits in one row; otherwise the last one, cut to fit.
  function fitOne(cands, cols) {
    for (const c of cands) if (c && chars(c).length <= cols) return c;
    return chars(cands[cands.length - 1]).slice(0, cols).join("");
  }
  function wrapText(text, cols, maxRows) {
    const out = [];
    for (const raw of String(text || "").toUpperCase().split("\n"))
      if (raw.trim()) out.push(...wrapLine(raw.trim(), cols).map((l) => l.join("")));
    return out.slice(0, maxRows);
  }

  // Calendar events arrive as { start: ISO, allDay, title }; convert them to
  // this device's local date and time. All-day events have no time to wait
  // for, so the "next" item only considers timed events.
  function calendarItems(events) {
    return (events || []).filter((e) => !e.allDay).map((e) => {
      const d = new Date(e.start);
      return { date: localDate(d), time: hhmm(d), title: e.title, fromCalendar: true };
    });
  }

  /** Today's timed items (typed + calendar), sorted by time. */
  function todayItems(cfg, now, events) {
    const today = localDate(now);
    return [...(cfg.schedule.items || []), ...calendarItems(events)]
      .filter((i) => i.date === today)
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  function nextEvent(cfg, now, events) {
    const t = hhmm(now);
    return todayItems(cfg, now, events).find((i) => i.time >= t) || null;
  }

  const WIDGET_LINES = {
    clock(cfg, { now, cols }) {
      const h = now.getHours(), m = now.getMinutes(), h24 = cfg.clock.h24;
      const t = fmtTime(h, m, h24), tc = fmtTime(h, m, h24, true);
      const d = `${DAYS[now.getDay()]} ${MONTHS[now.getMonth()]} ${now.getDate()}`;
      return [fitOne([`${d}  ${t}`, `${d} ${t}`, `${d} ${tc}`, `${MONTHS[now.getMonth()]} ${now.getDate()} ${tc}`, t, tc], cols)];
    },
    schedule(cfg, { now, cols, calendar }) {
      const e = nextEvent(cfg, now, calendar);
      if (!e) return [fitOne(["NO MORE EVENTS TODAY", "NO EVENTS"], cols)];
      const [h, m] = e.time.split(":").map(Number);
      return wrapText(`${fmtTime(h, m, cfg.clock.h24, cols < 16)} ${e.title || "EVENT"}`, cols, 2);
    },
    weather(cfg, { weather, cols }) {
      if (cfg.weather.lat == null) return [fitOne(["WEATHER: SET LOCATION", "SET LOCATION"], cols)];
      if (!weather) return [fitOne(["WEATHER LOADING...", "LOADING"], cols)];
      if (weather.error) return [fitOne(["WEATHER UNAVAILABLE", "NO WEATHER"], cols)];
      const t = `${weather.temp}${cfg.weather.unit}`, hl = weather.hi != null ? ` H${weather.hi} L${weather.lo}` : "";
      const long = String(weather.desc || "").toUpperCase(), short = String(weather.short || long).toUpperCase();
      return [fitOne([`${t} ${long}${hl}`, `${t} ${short}${hl}`, `${t} ${long}`, `${t} ${short}`, t], cols)];
    },
    notes(cfg, { cols }) {
      return wrapText(cfg.notes.text, cols, 2);
    },
  };

  /** -> [{ id, lines: string[] }] for enabled widgets, in order */
  function widgetBlocks(cfg, ctx) {
    return cfg.order.filter((id) => cfg.on[id] && WIDGET_LINES[id])
      .map((id) => ({ id, lines: WIDGET_LINES[id](cfg, ctx) }));
  }
  /** Widgets as board text (one line per row), ready for layout(). */
  function widgetText(cfg, ctx) {
    return widgetBlocks(cfg, ctx).flatMap((b) => b.lines).join("\n");
  }

  global.Flap = {
    SPOOL, COLORS, chars, layout,
    WIDGETS, WIDGET_IDS, defaultWidgets, widgetBlocks, widgetText, nextEvent, todayItems, localDate, fmtTime,
  };
})(window);
