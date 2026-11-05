// Line-based diff, with no VS Code imports. Used in two places:
//  - the extension, to move highlights after a file is changed outside VS Code
//  - the Claude Code hook, to find the lines Claude added or changed

/** Split text into lines, remembering where each line starts. */
function splitLines(text) {
  const lines = [];
  const starts = [];
  let pos = 0;
  while (true) {
    const nl = text.indexOf('\n', pos);
    starts.push(pos);
    if (nl === -1) {
      lines.push(text.slice(pos));
      break;
    }
    lines.push(text.slice(pos, nl).replace(/\r$/, ''));
    pos = nl + 1;
  }
  return { lines, starts };
}

/**
 * Pairs of equal lines [oldIndex, newIndex] (a longest common subsequence), in order.
 * Common start and end are matched directly; the middle uses Myers' diff.
 * If the middle is very different, it is treated as fully replaced.
 */
function matchLines(a, b, maxD = 1000) {
  const pairs = [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pairs.push([pre, pre++]);
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  for (const [i, j] of myers(A, B, maxD)) pairs.push([i + pre, j + pre]);
  for (let k = suf; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

function myers(A, B, maxD) {
  const N = A.length, M = B.length;
  if (!N || !M) return [];
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return []; // too different: no matches in the middle
  trace.push(v.slice());

  // Walk back through the saved states to collect the matching ("snake") lines.
  const pairs = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[off + k - 1] < prev[off + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) pairs.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

/**
 * Lines of newText that were added or changed compared to oldText, grouped into blocks
 * [{ start, end }] (0-based, inclusive). Blocks only a short gap apart are joined, and
 * blank lines at a block's edges are dropped.
 */
function changedBlocks(oldText, newText, joinGap = 1) {
  const a = splitLines(oldText).lines;
  const b = splitLines(newText).lines;
  if (newText === '') return [];
  const matched = new Uint8Array(b.length);
  for (const [, j] of matchLines(a, b)) matched[j] = 1;

  const blocks = [];
  for (let j = 0; j < b.length; j++) {
    if (matched[j]) continue;
    const last = blocks[blocks.length - 1];
    if (last && j - last.end - 1 <= joinGap) last.end = j;
    else blocks.push({ start: j, end: j });
  }
  // A file ending in a newline has an empty last "line"; never highlight it.
  return blocks
    .map(({ start, end }) => {
      while (start <= end && !b[start].trim()) start++;
      while (end >= start && !b[end].trim()) end--;
      return { start, end };
    })
    .filter((x) => x.end >= x.start);
}

/**
 * Move highlights { start, end } (character offsets in oldText) so they cover the same code in newText.
 * Lines that stayed the same keep their highlight; changed lines inside a block stay in the block.
 * A block whose lines were all replaced covers the replacement, or is dropped if it was deleted.
 */
function remapByDiff(highlights, oldText, newText) {
  if (oldText === newText || !highlights.length) return highlights;
  const O = splitLines(oldText);
  const N = splitLines(newText);
  const pairs = matchLines(O.lines, N.lines);
  const toNew = new Int32Array(O.lines.length).fill(-1);
  for (const [i, j] of pairs) toNew[i] = j;
  // For each old line: the nearest matched old line at or before / at or after it.
  const before = new Int32Array(O.lines.length);
  const after = new Int32Array(O.lines.length);
  for (let i = 0, last = -1; i < O.lines.length; i++) before[i] = last = toNew[i] >= 0 ? i : last;
  for (let i = O.lines.length - 1, next = -1; i >= 0; i--) after[i] = next = toNew[i] >= 0 ? i : next;

  const pos = (S, offset) => {
    // Binary search for the line containing offset.
    let lo = 0, hi = S.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, ch: offset - S.starts[lo] };
  };
  const offsetAt = (line, ch) => N.starts[line] + Math.max(0, Math.min(ch, N.lines[line].length));
  const newOf = (i) => (i < 0 ? -1 : i >= O.lines.length ? N.lines.length : toNew[i]);

  const result = [];
  for (const h of highlights) {
    let s = pos(O, Math.min(h.start, oldText.length));
    let e = pos(O, Math.min(h.end, oldText.length));
    // Same conventions as the editor: starting at a line's end means the next line,
    // ending at column 0 means the end of the previous line.
    if (s.line < e.line && s.ch > 0 && s.ch >= O.lines[s.line].length) s = { line: s.line + 1, ch: 0 };
    if (e.ch === 0 && e.line > s.line) e = { line: e.line - 1, ch: O.lines[e.line - 1].length };

    const first = after[s.line] >= 0 && after[s.line] <= e.line ? after[s.line] : -1;
    const last = before[e.line] >= s.line ? before[e.line] : -1;
    // Where the unchanged neighbours of the block went; the block must stay between them.
    const prevNew = s.line > 0 && before[s.line - 1] >= 0 ? newOf(before[s.line - 1]) : -1;
    const nextNew = e.line + 1 < O.lines.length && after[e.line + 1] >= 0 ? newOf(after[e.line + 1]) : N.lines.length;

    let ns, ne;
    if (first >= 0) {
      ns = Math.max(prevNew + 1, toNew[first] - (first - s.line));
      ne = Math.min(nextNew - 1, toNew[last] + (e.line - last));
    } else {
      // Every line of the block changed: take the matching stretch of the replacement.
      const gapOldStart = s.line > 0 && before[s.line - 1] >= 0 ? before[s.line - 1] + 1 : 0;
      const gapOldEnd = e.line + 1 < O.lines.length && after[e.line + 1] >= 0 ? after[e.line + 1] - 1 : O.lines.length - 1;
      ns = prevNew + 1 + (s.line - gapOldStart);
      ne = nextNew - 1 - (gapOldEnd - e.line);
    }
    if (ne < ns || ns >= N.lines.length) continue;
    ne = Math.min(ne, N.lines.length - 1);

    const keepStartCh = first === s.line;
    const keepEndCh = last === e.line;
    const start = offsetAt(ns, keepStartCh ? s.ch : 0);
    const end = offsetAt(ne, keepEndCh ? e.ch : Infinity);
    if (end > start) result.push({ ...h, start, end });
  }
  return result;
}

/** Find a block of lines in text; if it appears more than once, take the one nearest `hintLine`. Returns the first line or -1. */
function findLines(text, blockLines, hintLine = 0) {
  const lines = splitLines(text).lines;
  const want = blockLines.map((l) => l.replace(/\r$/, ''));
  let best = -1;
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (lines[i] !== want[0]) continue;
    let ok = true;
    for (let k = 1; k < want.length && ok; k++) ok = lines[i + k] === want[k];
    if (ok && (best < 0 || Math.abs(i - hintLine) < Math.abs(best - hintLine))) best = i;
  }
  return best;
}

module.exports = { splitLines, matchLines, changedBlocks, remapByDiff, findLines };
