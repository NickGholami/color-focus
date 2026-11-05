const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/ranges');

const H = (start, end, color = 'red') => ({ start, end, color });
const noId = (list) => list.map(({ id, ...rest }) => rest);

test('edit before a highlight shifts it', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 0, 0, 5), [H(15, 25)]);
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 2, 3, 0), [H(7, 17)]);
});

test('edit after a highlight leaves it alone', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 25, 0, 5), [H(10, 20)]);
});

test('typing inside grows the highlight', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 15, 0, 4), [H(10, 24)]);
});

test('typing exactly at the start or end does not grow it', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 10, 0, 3), [H(13, 23)]);
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 20, 0, 3), [H(10, 20)]);
});

test('deleting the whole highlighted text removes it', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 5, 20, 0), []);
});

test('deleting across the start trims it', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 5, 10, 0), [H(5, 10)]);
});

test('deleting across the end trims it', () => {
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 15, 10, 0), [H(10, 15)]);
});

test('replacing across the start keeps the replacement outside', () => {
  // delete 5..15, insert 2 chars -> new text occupies 5..7, highlight remainder 7..12
  assert.deepStrictEqual(R.applyChange([H(10, 20)], 5, 10, 2), [H(7, 12)]);
});

test('new highlight replaces overlapping color and splits', () => {
  const list = noId(R.addHighlight([H(0, 30, 'red')], 10, 20, 'blue'));
  assert.deepStrictEqual(list, [H(0, 10, 'red'), H(10, 20, 'blue'), H(20, 30, 'red')]);
});

test('same color next to each other merges', () => {
  assert.deepStrictEqual(noId(R.addHighlight([H(0, 10)], 10, 20, 'red')), [H(0, 20)]);
});

test('labels are kept and stop merging', () => {
  const list = noId(R.addHighlight([H(0, 10)], 10, 20, 'red', ['bug', 'exercise 1']));
  assert.deepStrictEqual(list, [H(0, 10), { ...H(10, 20), labels: ['bug', 'exercise 1'] }]);
  assert.deepStrictEqual(R.applyChange(list, 0, 0, 2)[1], { ...H(12, 22), labels: ['bug', 'exercise 1'] });
  assert.deepStrictEqual(R.subtract(list, 14, 16).map((h) => R.labelsOf(h).length), [0, 2, 2]);
});

test('same labels in a different order still merge', () => {
  const list = R.addHighlight([{ ...H(0, 10), labels: ['b', 'a'] }], 10, 20, 'red', ['a', 'b']);
  assert.deepStrictEqual(noId(list), [{ ...H(0, 20), labels: ['b', 'a'] }]);
});

test('label helpers', () => {
  assert.deepStrictEqual(R.labelsOf({ label: 'old' }), ['old']);
  assert.deepStrictEqual(R.labelsOf({}), []);
  assert.deepStrictEqual(R.normalizeLabels(' a , b,a,, ', true), ['a', 'b']);
  assert.deepStrictEqual(R.normalizeLabels('a, b'), ['a, b']);
  assert.deepStrictEqual(R.normalizeLabels(undefined), []);
  assert.deepStrictEqual(R.withLabels({ ...H(0, 1), label: 'old' }, ['x']), { ...H(0, 1), labels: ['x'] });
  assert.deepStrictEqual(R.withLabels({ ...H(0, 1), labels: ['x'] }, []), H(0, 1));
});

test('subtract erases part of a highlight', () => {
  assert.deepStrictEqual(noId(R.subtract([H(0, 30)], 10, 20)), [H(0, 10), H(20, 30)]);
  const split = R.subtract([{ ...H(0, 30), id: 'a' }], 10, 20);
  assert.strictEqual(split[0].id, 'a');
  assert.notStrictEqual(split[1].id, 'a');
});

test('complement finds the gaps', () => {
  assert.deepStrictEqual(R.complement([{ start: 2, end: 4 }, { start: 3, end: 6 }, { start: 8, end: 10 }], 12), [
    { start: 0, end: 2 },
    { start: 6, end: 8 },
    { start: 10, end: 12 },
  ]);
  assert.deepStrictEqual(R.complement([], 5), [{ start: 0, end: 5 }]);
});

test('colors', () => {
  assert.strictEqual(R.toBackground('#ff0000', 0.2), 'rgba(255, 0, 0, 0.2)');
  assert.strictEqual(R.toBackground('#f00', 0.5), 'rgba(255, 0, 0, 0.5)');
  assert.strictEqual(R.toBackground('rgba(1,2,3,0.4)', 0.2), 'rgba(1,2,3,0.4)');
  assert.strictEqual(R.swatch('#ff5c5c'), '🔴');
  assert.strictEqual(R.swatch('#6bcb77'), '🟢');
  assert.strictEqual(R.swatch('#4d96ff'), '🔵');
  assert.strictEqual(R.swatch('#9e9e9e'), '⚪');
});

test('addLabeled: overlapping code keeps its labels and gets the new one', () => {
  const ex2 = { id: 'a', start: 10, end: 50, color: 'yellow', labels: ['Exercise 2'] };
  const out = R.addLabeled([ex2], 20, 70, 'teal', ['Exercise 3']);
  assert.deepStrictEqual(out.map(({ id, ...h }) => h), [
    { start: 10, end: 20, color: 'yellow', labels: ['Exercise 2'] },
    { start: 20, end: 50, color: 'teal', labels: ['Exercise 2', 'Exercise 3'] },
    { start: 50, end: 70, color: 'teal', labels: ['Exercise 3'] },
  ]);
  assert.strictEqual(out[0].id, 'a', 'the remaining part keeps its id');
});

test('addLabeled: same label again changes nothing; line breaks between blocks are not colored', () => {
  const h = { id: 'a', start: 0, end: 9, color: 'red', labels: ['x'] };
  assert.deepStrictEqual(R.addLabeled([h], 0, 9, 'blue', ['x']), [h]);
  const a = { id: 'a', start: 0, end: 9, color: 'red', labels: ['x'] };
  const b = { id: 'b', start: 10, end: 19, color: 'red', labels: ['y'] };
  const out = R.addLabeled([a, b], 0, 19, 'blue', ['z']);
  assert.deepStrictEqual(out.map((h) => [h.start, h.end, h.labels.join('+')]), [[0, 9, 'x+z'], [10, 19, 'y+z']]);
});

// --- blocks made of several pieces (the grades.py run with Codex: 0-based lines) ---
const ex1 = '#ff9f43', ex2 = '#ffd93d', ex3 = '#2ec4b6';
const gradesPieces = [
  { startLine: 14, endLine: 19, labels: ['Exercise 1'], color: ex1 },
  { startLine: 24, endLine: 25, labels: ['Exercise 3'], color: ex3 },
  { startLine: 35, endLine: 36, labels: ['Exercise 2'], color: ex2 }, // best_student, written for exercise 2
  { startLine: 37, endLine: 42, labels: ['Exercise 2', 'Exercise 3'], color: ex3 }, // ...partly rewritten for 3
  { startLine: 50, endLine: 55, labels: ['Exercise 3'], color: ex3 }, // print_report loop
  { startLine: 56, endLine: 59, labels: ['Exercise 2', 'Exercise 3'], color: ex3 },
];

test('joinTouching: touching pieces sharing a label are one block, each label once and in order', () => {
  const blocks = R.joinTouching(gradesPieces, R.sharesLabel);
  assert.deepStrictEqual(blocks.map((b) => [b.startLine, b.endLine, b.labels.join(' + ')]), [
    [14, 19, 'Exercise 1'],
    [24, 25, 'Exercise 3'],
    [35, 42, 'Exercise 2 + Exercise 3'],
    [50, 59, 'Exercise 2 + Exercise 3'],
  ]);
});

test('joinTouching: pieces with no label in common, or with a free line between, stay apart', () => {
  const a = { startLine: 0, endLine: 2, labels: ['A'] };
  const b = { startLine: 3, endLine: 4, labels: ['B'] };
  const c = { startLine: 6, endLine: 7, labels: ['B'] };
  assert.strictEqual(R.joinTouching([a, b, c], R.sharesLabel).length, 3);
  assert.deepStrictEqual(R.joinTouching([c, a, b]).map((x) => [x.startLine, x.endLine]), [[0, 4], [6, 7]]); // no rule: touching only
  assert.deepStrictEqual(R.sortLabels(['Exercise 10', 'exercise 2', 'Exercise 1']), ['Exercise 1', 'exercise 2', 'Exercise 10']);
});

test('labelColors: a label keeps the color of its own highlights', () => {
  const toHighlights = (pieces) => pieces.map((p) => ({ color: p.color, labels: p.labels }));
  const colors = R.labelColors(toHighlights(gradesPieces));
  assert.deepStrictEqual(Object.fromEntries(colors), { 'Exercise 1': ex1, 'Exercise 3': ex3, 'Exercise 2': ex2 });
  // Only shared pieces: the piece's color belongs to its newest label
  assert.deepStrictEqual(Object.fromEntries(R.labelColors([{ color: 'blue', labels: ['A', 'B'] }])), { A: 'blue', B: 'blue' });
});

test('pickLabelColor: a new label never takes a color another label has in the file', () => {
  const palette = ['#ff5c5c', ex1, ex2, '#6bcb77', ex3, '#4d96ff'];
  const file = [{ color: ex1, labels: ['Exercise 1'] }, { color: ex3, labels: ['Exercise 2'] }];
  // "Exercise 3" was teal in another file of the project, but teal is "Exercise 2" here
  const project = [...file, { color: ex3, labels: ['Exercise 3'] }];
  const c = R.pickLabelColor(['Exercise 3'], { fileHighlights: file, projectHighlights: project, palette });
  assert.ok(![ex1, ex3].includes(c), c);
  // Same label again: same color
  assert.strictEqual(R.pickLabelColor(['Exercise 2'], { fileHighlights: file, projectHighlights: project, palette }), ex3);
  // A label used elsewhere in the project keeps its color when it's free here
  assert.strictEqual(R.pickLabelColor(['Task 9'], { fileHighlights: file, projectHighlights: [{ color: '#4d96ff', labels: ['Task 9'] }], palette }), '#4d96ff');
  // Otherwise the first color nobody in the project uses
  assert.strictEqual(R.pickLabelColor(['New'], { fileHighlights: file, projectHighlights: project, palette }), '#ff5c5c');
});
