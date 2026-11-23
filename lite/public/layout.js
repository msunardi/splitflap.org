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

  global.Flap = { SPOOL, COLORS, chars, layout };
})(window);
