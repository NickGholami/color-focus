// Pure helpers for highlight ranges. No VS Code imports, so they can be unit tested with plain node.
// A highlight is { start, end, color } where start/end are character offsets in the document.

/**
 * Move highlights so they follow the text after one edit.
 * Text typed exactly at a highlight's start or end is NOT added to it;
 * text typed inside it is.
 */
function applyChange(highlights, rangeOffset, rangeLength, insertedLength) {
  const changeEnd = rangeOffset + rangeLength;
  const delta = insertedLength - rangeLength;
  const result = [];

  for (const h of highlights) {
    let { start, end } = h;

    if (end <= rangeOffset) {
      // Entirely before the edit: untouched.
    } else if (start >= changeEnd) {
      // Entirely after the edit: shift.
      start += delta;
      end += delta;
    } else {
      // Overlaps the edited text.
      if (start > rangeOffset) start = rangeOffset + insertedLength;
      end = end >= changeEnd ? end + delta : rangeOffset;
      if (start > end) start = end;
    }

    if (end > start) result.push({ ...h, start, end });
  }
  return result;
}

let idCounter = 0;
/** Short unique id for a highlight block. */
function newId() {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
}

/** A highlight's labels as an array. Also reads the single `label` field older versions saved. */
function labelsOf(h) {
  if (Array.isArray(h.labels)) return h.labels;
  return h.label ? [h.label] : [];
}

/** Turn a string, comma-separated string or array into a clean list of unique labels. */
function normalizeLabels(value, splitCommas = false) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const parts = splitCommas ? raw.flatMap((v) => String(v).split(',')) : raw.map(String);
  return [...new Set(parts.map((l) => l.trim()).filter(Boolean))];
}

function sameLabels(a, b) {
  const x = [...labelsOf(a)].sort();
  const y = [...labelsOf(b)].sort();
  return x.length === y.length && x.every((l, i) => l === y[i]);
}

/** Copy of a highlight with new labels (no labels = field removed). */
function withLabels(h, labels) {
  const { label, labels: _old, ...rest } = h;
  const clean = normalizeLabels(labels);
  return clean.length ? { ...rest, labels: clean } : rest;
}

/** Remove [start, end) from every highlight, splitting ones that straddle it. */
function subtract(highlights, start, end) {
  const result = [];
  for (const h of highlights) {
    if (h.end <= start || h.start >= end) {
      result.push(h);
      continue;
    }
    if (h.start < start) result.push({ ...h, end: start });
    // The right-hand piece is a new block, so it gets its own id.
    if (h.end > end) result.push({ ...h, start: end, id: h.start < start ? newId() : h.id });
  }
  return result;
}

/**
 * Add a highlight; it replaces whatever was colored in that area before.
 * Touching pieces with the same color and the same labels merge into one.
 */
function addHighlight(highlights, start, end, color, labels) {
  const list = subtract(highlights, start, end);
  const h = { id: newId(), start, end, color };
  const clean = normalizeLabels(labels);
  if (clean.length) h.labels = clean;
  list.push(h);
  return mergeTouching(list);
}

/** Sort, and join touching pieces that have the same color and the same labels. */
function mergeTouching(list) {
  list = [...list].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const h of list) {
    const last = merged[merged.length - 1];
    if (last && last.color === h.color && sameLabels(last, h) && last.end >= h.start) {
      last.end = Math.max(last.end, h.end);
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

/**
 * Add labels to [start, end) without taking away labels that are already there.
 * Code that already has a highlight keeps its labels and gets the new ones too (and the new color);
 * uncolored code in the range becomes a new highlight. Used for code Claude Code changes:
 * lines written for "Exercise 2" and changed again for "Exercise 3" belong to both.
 */
function addLabeled(highlights, start, end, color, labels) {
  const add = normalizeLabels(labels);
  const result = [];
  const covered = [];
  for (const h of highlights) {
    if (h.end <= start || h.start >= end) {
      result.push(h);
      continue;
    }
    const s = Math.max(h.start, start);
    const e = Math.min(h.end, end);
    if (h.start < s) result.push({ ...h, end: s });
    const both = normalizeLabels([...labelsOf(h), ...add]);
    const unchanged = both.length === labelsOf(h).length;
    result.push({ ...withLabels(h, both), start: s, end: e, color: unchanged ? h.color : color, id: h.start < s ? newId() : h.id });
    if (h.end > e) result.push({ ...h, start: e, id: newId() });
    covered.push({ start: s, end: e });
  }
  // The rest of the range: new highlight(s). Leftovers of 1-2 characters are just line breaks between blocks.
  for (const gap of complement(covered.map((c) => ({ start: c.start - start, end: c.end - start })), end - start)) {
    if (gap.end - gap.start <= 2 && covered.length) continue;
    const h = { id: newId(), start: start + gap.start, end: start + gap.end, color };
    if (add.length) h.labels = add;
    result.push(h);
  }
  return mergeTouching(result);
}

/** Parts of [0, total) not covered by any of the given [start, end) intervals. */
function complement(intervals, total) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const gaps = [];
  let cursor = 0;
  for (const { start, end } of sorted) {
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < total) gaps.push({ start: cursor, end: total });
  return gaps;
}

/** Turn "#rgb" / "#rrggbb" / "#rrggbbaa" into rgba() with the given opacity. Other CSS colors pass through. */
function toBackground(color, opacity) {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
}

function parseHex(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color).trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Closest colored-circle emoji, so color pickers show a swatch. */
function swatch(color) {
  const rgb = parseHex(color);
  if (!rgb) return '⬤';
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  if (sat < 0.2) return light > 0.5 ? '⚪' : '⚫';
  let hue;
  if (max === r) hue = 60 * (((g - b) / (max - min)) % 6);
  else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
  else hue = 60 * ((r - g) / (max - min) + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 330) return '🔴';
  if (hue < 40) return light < 0.35 ? '🟤' : '🟠';
  if (hue < 70) return '🟡';
  if (hue < 165) return '🟢';
  if (hue < 260) return '🔵';
  return '🟣';
}

module.exports = { labelsOf, normalizeLabels, sameLabels, withLabels, newId, applyChange, subtract, addHighlight, addLabeled, mergeTouching, complement, toBackground, parseHex, swatch };
