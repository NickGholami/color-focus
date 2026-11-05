const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/linediff');

const text = (...lines) => lines.join('\n') + '\n';
/** Highlight covering whole lines a..b (0-based, inclusive) of t. */
function H(t, a, b) {
  const { starts, lines } = D.splitLines(t);
  return { start: starts[a], end: starts[b] + lines[b].length };
}
/** Which lines a highlight covers in t, as "a-b". */
function lines(t, h) {
  const { starts } = D.splitLines(t);
  const lineOf = (o) => starts.filter((s) => s <= o).length - 1;
  return `${lineOf(h.start)}-${lineOf(h.end)}`;
}

test('matchLines finds the longest common lines', () => {
  const a = ['a', 'b', 'c', 'd', 'e'];
  const b = ['a', 'x', 'c', 'd', 'y', 'e'];
  assert.deepStrictEqual(D.matchLines(a, b), [[0, 0], [2, 2], [3, 3], [4, 5]]);
  assert.deepStrictEqual(D.matchLines([], ['a']), []);
  // Random check: matched lines are equal and strictly increasing.
  for (let n = 0; n < 200; n++) {
    const r = () => Array.from({ length: Math.floor(Math.random() * 30) }, () => 'abcde'[Math.floor(Math.random() * 5)]);
    const x = r(), y = r();
    const p = D.matchLines(x, y);
    p.forEach(([i, j], k) => {
      assert.strictEqual(x[i], y[j]);
      if (k) assert.ok(i > p[k - 1][0] && j > p[k - 1][1]);
    });
  }
});

test('changedBlocks: an edit in the middle of a function', () => {
  const before = text('def a():', '    return 1', '', 'def b():', '    return 2', '', 'def c():', '    return 3');
  const after = text('def a():', '    return 1', '', 'def b():', '    print("hi")', '    return 20', '', 'def c():', '    return 3');
  assert.deepStrictEqual(D.changedBlocks(before, after), [{ start: 4, end: 5 }]);
});

test('changedBlocks: a new file is one block, blank edges dropped, close blocks joined', () => {
  assert.deepStrictEqual(D.changedBlocks('', text('', 'x = 1', 'y = 2', '')), [{ start: 1, end: 2 }]);
  const before = text('a', 'b', 'c', 'd', 'e', 'f', 'g');
  assert.deepStrictEqual(D.changedBlocks(before, text('a', 'B', 'c', 'D', 'e', 'f', 'G')), [{ start: 1, end: 3 }, { start: 6, end: 6 }]);
  assert.deepStrictEqual(D.changedBlocks(before, text('a', 'b', 'd')), []); // only deletions
});

test('remapByDiff: lines added above move the block down', () => {
  const before = text('a', 'b', 'c', 'd');
  const after = text('new1', 'new2', 'a', 'b', 'c', 'd');
  assert.strictEqual(lines(after, D.remapByDiff([H(before, 1, 2)], before, after)[0]), '3-4');
});

test('remapByDiff: edits above and below at the same time (one big external change)', () => {
  const before = text('top', 'f1', 'f2', 'f3', 'bottom');
  const after = text('TOP', 'extra', 'f1', 'f2', 'f3', 'BOTTOM', 'more');
  assert.strictEqual(lines(after, D.remapByDiff([H(before, 1, 3)], before, after)[0]), '2-4');
});

test('remapByDiff: lines changed or added inside the block stay in it', () => {
  const before = text('x', 's1', 's2', 's3', 'y');
  const after = text('x', 's1', 'S2 changed', 'inserted', 's3', 'y');
  assert.strictEqual(lines(after, D.remapByDiff([H(before, 1, 3)], before, after)[0]), '1-4');
  // First/last line of the block changed
  const after2 = text('x', 'S1', 's2', 'S3', 'y');
  assert.strictEqual(lines(after2, D.remapByDiff([H(before, 1, 3)], before, after2)[0]), '1-3');
});

test('remapByDiff: a block whose lines were all replaced covers the replacement; deleted blocks go away', () => {
  const before = text('x', 'old1', 'old2', 'y');
  const after = text('x', 'new1', 'new2', 'new3', 'y');
  assert.strictEqual(lines(after, D.remapByDiff([H(before, 1, 2)], before, after)[0]), '1-3');
  assert.deepStrictEqual(D.remapByDiff([H(before, 1, 2)], before, text('x', 'y')), []);
});

test('remapByDiff: lines added right at the edges are not added to the block', () => {
  const before = text('x', 'b1', 'b2', 'y');
  const after = text('x', 'above', 'b1', 'b2', 'below', 'y');
  assert.strictEqual(lines(after, D.remapByDiff([H(before, 1, 2)], before, after)[0]), '2-3');
});

test('remapByDiff keeps other fields and works with CRLF', () => {
  const before = 'a\r\nb\r\nc\r\n';
  const after = 'z\r\na\r\nb\r\nc\r\n';
  const h = { id: 'q', color: 'red', labels: ['x'], start: 3, end: 4 }; // "b"
  const [m] = D.remapByDiff([h], before, after);
  assert.deepStrictEqual({ ...m, start: undefined, end: undefined }, { ...h, start: undefined, end: undefined });
  assert.strictEqual(after.slice(m.start, m.end), 'b');
});

test('findLines picks the occurrence nearest the hint', () => {
  const t = text('a', 'x', 'y', 'b', 'x', 'y', 'c');
  assert.strictEqual(D.findLines(t, ['x', 'y'], 0), 1);
  assert.strictEqual(D.findLines(t, ['x', 'y'], 5), 4);
  assert.strictEqual(D.findLines(t, ['nope'], 0), -1);
});
