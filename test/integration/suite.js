const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (ed) => ed.visibleRanges.map((r) => `${r.start.line}-${r.end.line}`).join(',');
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

async function open(name) {
  const doc = await vscode.workspace.openTextDocument(path.join(root(), name));
  const ed = await vscode.window.showTextDocument(doc);
  await sleep(800);
  return ed;
}
async function highlight(ed, from, to, color, label) {
  ed.selection = new vscode.Selection(from, 0, to, ed.document.lineAt(to).text.length);
  await vscode.commands.executeCommand('colorFocus.highlight', Array.isArray(label) ? { color, labels: label } : { color, label });
  await sleep(800);
}
async function foldAt(line) {
  await vscode.commands.executeCommand('editor.unfoldAll');
  await vscode.commands.executeCommand('editor.fold', { selectionLines: [line], levels: 1 });
  await sleep(300);
}

exports.run = async () => {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
  };
  const api = await vscode.extensions.getExtension('NickGholami.color-focus').activate();

  // --- folding ---
  const py = await open('a.py');
  await check('adding a highlight does not move the cursor or scroll', async () => {
    py.selection = new vscode.Selection(4, 0, 7, 4);
    const before = vis(py);
    await vscode.commands.executeCommand('colorFocus.highlight', { color: '#6bcb77', labels: ['exercise 1'] }); // from inside foo() to after it
    await sleep(800);
    assert.strictEqual(vis(py), before, 'nothing folded or scrolled');
    assert.ok(py.selection.isEqual(new vscode.Selection(4, 0, 7, 4)), 'selection untouched');
  });
  const toggle = async (line) => {
    py.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('colorFocus.toggleFold');
    await sleep(400);
  };
  await check('Fold/Unfold folds a block that crosses a function', async () => {
    await toggle(5);
    assert.strictEqual(vis(py), '0-4,8-12');
    assert.strictEqual(py.selection.active.line, 4, 'cursor moved to the fold line');
  });
  await check('Fold/Unfold again unfolds it', async () => {
    await toggle(4);
    assert.strictEqual(vis(py), '0-12');
  });
  await check('after the first fold, the block keeps a normal fold (arrow)', async () => {
    await foldAt(4);
    assert.strictEqual(vis(py), '0-4,8-12');
    await vscode.commands.executeCommand('editor.unfoldAll');
  });
  await check('python indentation folding still works', async () => {
    await foldAt(10);
    const hidden = (l) => !py.visibleRanges.some((r) => l >= r.start.line && l <= r.end.line);
    assert.ok(!hidden(10) && hidden(11), vis(py));
  });
  await check('fold moves when lines are inserted above', async () => {
    await vscode.commands.executeCommand('editor.unfoldAll');
    await py.edit((b) => b.insert(new vscode.Position(0, 0), '# one\n# two\n'));
    await sleep(500);
    await foldAt(6);
    assert.strictEqual(vis(py), '0-6,10-14');
  });
  await check('removed block loses its fold', async () => {
    await vscode.commands.executeCommand('editor.unfoldAll');
    py.selection = new vscode.Selection(7, 0, 7, 0);
    await vscode.commands.executeCommand('colorFocus.removeAtCursor');
    await sleep(800);
    await foldAt(6);
    assert.notStrictEqual(vis(py), '0-6,10-14');
    // Take the 2 inserted lines out again so line numbers match the rest of the test.
    await py.edit((b) => b.delete(new vscode.Range(0, 0, 2, 0)));
    await sleep(300);
    await vscode.commands.executeCommand('editor.unfoldAll');
  });
  await highlight(py, 2, 5, '#6bcb77', 'exercise 1');
  await highlight(py, 10, 11, '#4d96ff', 'exercise 2');
  await check('fold all highlighted blocks', async () => {
    await vscode.commands.executeCommand('editor.unfoldAll');
    await vscode.commands.executeCommand('colorFocus.foldAll');
    await sleep(400);
    assert.strictEqual(vis(py), '0-2,6-10');
    await vscode.commands.executeCommand('colorFocus.unfoldAll');
  });

  const js = await open('b.js');
  await highlight(js, 1, 3, '#6bcb77', 'exercise 1');
  await highlight(js, 4, 4, '#4d96ff', 'exercise 2');
  const f90 = await open('c.f90');
  await highlight(f90, 3, 5, '#6bcb77', 'exercise 1');

  // --- blocks view ---
  await check('blocks view across files filtered by label', async () => {
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'workspace', label: 'exercise 1' });
    await sleep(1000);
    const ed = vscode.window.activeTextEditor;
    assert.strictEqual(ed.document.uri.scheme, 'colorfocus-blocks');
    const text = ed.document.getText();
    results.push('---- blocks view text ----\n' + text + '--------------------------');
    assert.ok(text.includes('━━ 1. a.py:3–6'), 'a.py header');
    assert.ok(text.includes('b.js:2–4'), 'b.js header');
    assert.ok(text.includes('c.f90:4–6'), 'c.f90 header');
    assert.ok(text.includes('def foo():'));
    assert.ok(!text.includes('def bar'), 'exercise 2 not included');
    assert.ok(!text.includes('console.log'), 'exercise 2 not included');
    assert.strictEqual(ed.document.languageId, 'plaintext'); // mixed languages
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', ed.document.uri);
    assert.strictEqual(lenses.length, 3);
    const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', ed.document.uri);
    assert.strictEqual(folds.length, 3);
  });
  await check('go to source from blocks view', async () => {
    const ed = vscode.window.activeTextEditor;
    const line = ed.document.getText().split('\n').findIndex((l) => l.includes('return x + y;'));
    ed.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('colorFocus.goToSource');
    await sleep(500);
    const now = vscode.window.activeTextEditor;
    assert.ok(now.document.fileName.endsWith('b.js'));
    assert.strictEqual(now.selection.active.line, 2);
  });
  await check('single-file blocks view keeps the language', async () => {
    await open('a.py');
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'file' });
    await sleep(1000);
    const ed = vscode.window.activeTextEditor;
    assert.strictEqual(ed.document.languageId, 'python');
    assert.ok(ed.document.getText().startsWith('# Color Focus · All highlights · 2 blocks'));
  });
  await check('blocks view updates live when source changes', async () => {
    const blocksDoc = vscode.window.activeTextEditor.document;
    const src = await open('a.py');
    await src.edit((b) => b.insert(new vscode.Position(3, 0), '    z = 99\n'));
    await sleep(1200);
    assert.ok(blocksDoc.getText().includes('z = 99'));
  });

  // --- several labels on one block ---
  await check('block with two labels shows in both label views', async () => {
    const ed = await open('b.js');
    await highlight(ed, 5, 5, '#ff9f43', ['exercise 1', 'exercise 2']);
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'workspace', label: 'exercise 2' });
    await sleep(1000);
    let text = vscode.window.activeTextEditor.document.getText();
    assert.ok(text.includes('const unused = 0;'), 'in exercise 2 view');
    assert.ok(text.includes('◆ exercise 1 ◆ exercise 2'), 'header shows both labels');
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'workspace', label: 'exercise 1' });
    await sleep(1000);
    text = vscode.window.activeTextEditor.document.getText();
    assert.ok(text.includes('const unused = 0;'), 'in exercise 1 view');
  });
  await check('label checklist: add new, tick existing, untick, finish', async () => {
    const ed = await open('b.js');
    ed.selection = new vscode.Selection(5, 0, 5, 0);
    const done = vscode.commands.executeCommand('colorFocus.setLabel');
    await sleep(600);
    const qp = api.testHooks.labelPicker;
    const enter = async () => { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await sleep(400); };
    assert.deepStrictEqual(qp.selectedItems.map((i) => i.label).sort(), ['exercise 1', 'exercise 2']);
    const dump = (tag) => results.push(`  [${tag}] value="${qp.value}" items=${qp.items.map((i) => i.label).join('|')} active=${qp.activeItems.map((i) => i.label)} selected=${qp.selectedItems.map((i) => i.label)} title=${qp.title}`);
    dump('start');
    qp.value = 'bug, todo'; await sleep(400); dump('typed'); await enter(); dump('after enter');
    qp.value = 'exercise 2'; await sleep(400); dump('typed2'); await enter(); dump('after enter2');
    qp.value = ''; await sleep(200); await enter();                    // finish
    await done; await sleep(800);
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'file' });
    await sleep(1000);
    const text = vscode.window.activeTextEditor.document.getText();
    results.push('---- labels after checklist ----\n' + text.split('\n').filter((l) => l.includes('b.js:6')).join('\n'));
    assert.ok(text.includes('b.js:6  ·  ◆ exercise 1 ◆ bug ◆ todo'), 'labels updated');
  });

  // --- folder-wide remove / rename ---
  const count = async (label) => {
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'workspace', label });
    await sleep(900);
    const t = vscode.window.activeTextEditor.document.getText();
    const m = /· (\d+) blocks?/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  const one = await open('ex1/one.py');
  await highlight(one, 0, 1, '#9b5de5', ['Exercise 1', 'keep']);
  const two = await open('ex2/two.py');
  await highlight(two, 0, 1, '#9b5de5', ['Exercise 1']);
  await check('rename a label everywhere', async () => {
    const before = await count('Exercise 1');
    assert.strictEqual(before, 2);
    await vscode.commands.executeCommand('colorFocus.renameLabel', { folder: '', from: 'Exercise 1', to: 'Exercise 0' });
    await sleep(600);
    assert.strictEqual(await count('Exercise 0'), 2);
    assert.strictEqual(await count('Exercise 1'), 0);
  });
  await check('rename a label only inside one folder', async () => {
    await vscode.commands.executeCommand('colorFocus.renameLabel', { folder: 'ex2', from: 'Exercise 0', to: 'Exercise 9' });
    await sleep(600);
    assert.strictEqual(await count('Exercise 0'), 1);
    assert.strictEqual(await count('Exercise 9'), 1);
  });
  await check('remove only a label in a folder keeps the block', async () => {
    await vscode.commands.executeCommand('colorFocus.removeInFolder', { folder: 'ex1', label: 'Exercise 0', labelOnly: true, confirm: false });
    await sleep(600);
    assert.strictEqual(await count('Exercise 0'), 0);
    assert.strictEqual(await count('keep'), 1);
  });
  await check('remove highlights with a label in a folder', async () => {
    await vscode.commands.executeCommand('colorFocus.removeInFolder', { folder: 'ex1', label: 'keep', labelOnly: false, confirm: false });
    await sleep(600);
    assert.strictEqual(await count('keep'), 0);
    assert.strictEqual(await count('Exercise 9'), 1, 'other folder untouched');
  });
  await check('remove all highlights in a folder leaves other folders', async () => {
    const all = await count(undefined);
    await vscode.commands.executeCommand('colorFocus.removeInFolder', { folder: 'ex2', all: true, confirm: false });
    await sleep(600);
    assert.strictEqual(await count(undefined), all - 1);
  });

  // --- single file ---
  const f1 = await open('ex1/one.py');
  await highlight(f1, 0, 0, '#ff5c5c', ['solo']);
  await highlight(f1, 2, 2, '#ff5c5c', ['solo']);
  const f3 = await open('ex1/three.py');
  await highlight(f3, 0, 1, '#ff5c5c', ['solo']);
  await check('rename a label in one file only', async () => {
    await vscode.commands.executeCommand('colorFocus.renameLabel', { file: 'ex1/one.py', from: 'solo', to: 'duo' });
    await sleep(600);
    assert.strictEqual(await count('duo'), 2);
    assert.strictEqual(await count('solo'), 1, 'three.py untouched');
  });
  await check('remove all highlights in one file only', async () => {
    await vscode.commands.executeCommand('colorFocus.removeInFolder', { file: 'ex1/one.py', all: true, confirm: false });
    await sleep(600);
    assert.strictEqual(await count('duo'), 0);
    assert.strictEqual(await count('solo'), 1, 'three.py untouched');
  });
  await check('right-click on a file is treated as that file, on a folder as that folder', async () => {
    const fileScope = await api.testHooks.bulk.pickScope(vscode.Uri.file(path.join(root(), 'ex1/three.py')));
    assert.strictEqual(fileScope.kind, 'file');
    assert.strictEqual(fileScope.name, 'three.py');
    const folderScope = await api.testHooks.bulk.pickScope(vscode.Uri.file(path.join(root(), 'ex1')));
    assert.strictEqual(folderScope.kind, 'folder');
  });

  // --- remove shortcut behaviour ---
  // Which lines are colored, as VS Code draws them.
  const spans = (ed) => api.testHooks.highlights(ed.document).map((h) => {
    const r = api.testHooks.toRange(ed.document, h);
    return `${r.start.line}-${r.end.line}`;
  }).join(',');
  const rm = await open('rm.txt');
  await highlight(rm, 1, 3, '#ff5c5c', 'a');
  await highlight(rm, 5, 9, '#4d96ff', 'b');
  await check('cursor in a block removes the whole block', async () => {
    rm.selection = new vscode.Selection(2, 1, 2, 1);
    await vscode.commands.executeCommand('colorFocus.removeAtCursor'); await sleep(500);
    assert.strictEqual(spans(rm), '5-9');
  });
  await check('selecting a few lines inside a block only removes those lines', async () => {
    rm.selection = new vscode.Selection(6, 0, 7, 2);
    await vscode.commands.executeCommand('colorFocus.removeAtCursor'); await sleep(500);
    assert.strictEqual(spans(rm), '5-5,8-9');
  });
  await check('re-coloring the middle of a block leaves clean pieces', async () => {
    await highlight(rm, 1, 6, '#ff5c5c', 'c');
    await highlight(rm, 3, 4, '#6bcb77', 'd');
    assert.strictEqual(spans(rm), '1-2,3-4,5-6,8-9');
  });
  await check('selecting across whole blocks removes them', async () => {
    rm.selection = new vscode.Selection(0, 0, 9, 2);
    await vscode.commands.executeCommand('colorFocus.removeAtCursor'); await sleep(500);
    assert.strictEqual(spans(rm), '');
  });

  // --- jumping ---
  await check('next / previous highlight move the cursor', async () => {
    const ed = await open('rm.txt');
    await highlight(ed, 1, 2, '#ff5c5c', 'j');
    await highlight(ed, 5, 6, '#4d96ff', 'j');
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    const lines = [];
    const files = [];
    for (const cmd of ['next', 'next', 'next', 'previous', 'previous', 'next', 'next']) {
      await vscode.commands.executeCommand('colorFocus.' + cmd); await sleep(300);
      lines.push(vscode.window.activeTextEditor.selection.active.line);
      files.push(path.basename(vscode.window.activeTextEditor.document.uri.path));
    }
    results.push('  jump lines: ' + lines.join(',') + '  blocks: ' + spans(ed) + '  files: ' + files.join(',') + '  visible editors: ' + vscode.window.visibleTextEditors.map((e) => path.basename(e.document.uri.path)).join(','));
    assert.deepStrictEqual(lines, [1, 5, 1, 5, 1, 5, 1]);
  });
  await check('previous from inside a block goes to the block before', async () => {
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(6, 0, 6, 0); // inside the 5-6 block
    await vscode.commands.executeCommand('colorFocus.previous'); await sleep(300);
    assert.strictEqual(ed.selection.active.line, 1);
  });
  await check('next / previous work in the blocks-only view', async () => {
    await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'file' });
    await sleep(1000);
    const ed = vscode.window.activeTextEditor;
    const headers = ed.document.getText().split('\n').map((l, i) => (l.startsWith('━━') ? i : -1)).filter((i) => i >= 0);
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('colorFocus.next'); await sleep(300);
    const first = ed.selection.active.line;
    await vscode.commands.executeCommand('colorFocus.next'); await sleep(300);
    assert.deepStrictEqual([first, ed.selection.active.line], headers.slice(0, 2));
  });

  // --- edits made outside VS Code (Claude Code, git) and the inbox ---
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const lineSpans = (doc) => api.testHooks.highlights(doc).map((h) => { const r = api.testHooks.toRange(doc, h); return `${r.start.line}-${r.end.line}`; }).join(',');
  const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await sleep(100); };
  const ext = path.join(root(), 'ext.py');
  const L = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag}${i}`);
  fs.writeFileSync(ext, L(10).join('\n') + '\n');

  await check('a change on disk (above and below at once) moves the highlight with its code', async () => {
    const ed = await open('ext.py');
    await highlight(ed, 4, 6, '#ff5c5c', 'outside');
    const doc = ed.document;
    const lines = L(10);
    fs.writeFileSync(ext, ['NEW A', 'NEW B', ...lines.slice(0, 4), ...lines.slice(4, 7), 'NEW C', ...lines.slice(7), 'NEW D'].join('\n') + '\n');
    await waitFor(() => doc.getText().startsWith('NEW A'));
    await sleep(300);
    assert.strictEqual(lineSpans(doc), '6-8');
  });

  await check('a change on disk while VS Code has no copy in memory is caught up from the saved copy', async () => {
    const doc = vscode.window.activeTextEditor.document;
    await sleep(800); // saved copy written
    api.testHooks.releaseText(doc);
    const now = doc.getText().split('\n');
    fs.writeFileSync(ext, ['TOP 1', 'TOP 2', 'TOP 3', ...now].join('\n'));
    await waitFor(() => doc.getText().startsWith('TOP 1'));
    await sleep(300);
    assert.strictEqual(lineSpans(doc), '9-11');
  });

  const home = process.env.COLOR_FOCUS_HOME;
  await check('a request in the inbox highlights the lines it names, with a color for its label', async () => {
    const f = path.join(root(), 'inbox.py');
    fs.writeFileSync(f, 'a = 1\n\ndef solve():\n    return 42\n\nb = 2\n');
    fs.writeFileSync(path.join(home, 'inbox', '000000000000001-test.json'), JSON.stringify({ file: f, labels: ['Exercise 7'], blocks: [{ line: 0, text: 'def solve():\n    return 42' }] }));
    await api.testHooks.inbox.flush();
    const doc = await vscode.workspace.openTextDocument(f);
    await waitFor(() => api.testHooks.highlights(doc).length > 0);
    assert.strictEqual(lineSpans(doc), '2-3');
    const h = api.testHooks.highlights(doc)[0];
    assert.deepStrictEqual(h.labels, ['Exercise 7']);
    assert.ok(h.color && !/9e9e9e/i.test(h.color));
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'inbox')), [], 'request removed');
  });

  await check('Claude Code end to end: hook + file edits on disk → highlighted, labeled, in open and unopened files', async () => {
    const claudeDir = path.join(__dirname, '../../claude');
    const node = process.env.NODE_BIN;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const run = (script, args, input) => execFileSync(node, [path.join(claudeDir, script), ...args], { env, cwd: root(), input, encoding: 'utf8' });
    run('color-focus.js', ['start', 'Exercise 2']);
    const edit = (file, text) => {
      const base = { session_id: 't', cwd: root(), tool_name: 'Edit', tool_input: { file_path: file } };
      run('hook.js', [], JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }));
      fs.writeFileSync(file, text);
      run('hook.js', [], JSON.stringify({ ...base, hook_event_name: 'PostToolUse' }));
    };
    // An open file: Claude changes the inside of a function
    const f1 = path.join(root(), 'inbox.py');
    const doc1 = await vscode.workspace.openTextDocument(f1);
    edit(f1, 'a = 1\n\ndef solve():\n    return 42\n\nb = 2\n\ndef extra(x):\n    y = x * 2\n    return y\n');
    // A file VS Code has never opened
    const f2 = path.join(root(), 'fresh.py');
    edit(f2, 'import math\n\nprint(math.pi)\n');
    run('color-focus.js', ['stop']);
    await api.testHooks.inbox.flush();
    await waitFor(() => api.testHooks.highlights(doc1).length > 1);
    assert.strictEqual(lineSpans(doc1), '2-3,7-9');
    const ex2 = api.testHooks.highlights(doc1)[1];
    assert.deepStrictEqual(ex2.labels, ['Exercise 2']);
    assert.notStrictEqual(ex2.color, api.testHooks.highlights(doc1)[0].color, 'a new label gets its own color');
    const doc2 = await vscode.workspace.openTextDocument(f2);
    assert.strictEqual(lineSpans(doc2), '0-2');
    assert.strictEqual(api.testHooks.highlights(doc2)[0].color, ex2.color, 'same label, same color');
  });

  // --- Claude's highlights always have a label ---
  await check('Claude changing code from an earlier exercise adds its label instead of replacing it', async () => {
    const f = path.join(root(), 'twice.py');
    fs.writeFileSync(f, 'def best():\n    return 1\n\nx = 0\n');
    const req = (labels, text, n) => fs.writeFileSync(path.join(home, 'inbox', `00000000000000${n}-t.json`), JSON.stringify({ file: f, labels, blocks: [{ line: 0, text }] }));
    req(['Exercise 2'], 'def best():\n    return 1', 2);
    await api.testHooks.inbox.flush();
    fs.writeFileSync(f, 'def best():\n    return 2\n\nx = 0\n');
    const doc = await vscode.workspace.openTextDocument(f);
    await waitFor(() => doc.getText().includes('return 2'));
    req(['Exercise 3'], '    return 2', 3);
    await api.testHooks.inbox.flush();
    await waitFor(() => api.testHooks.highlights(doc).length > 1);
    const got = api.testHooks.highlights(doc).map((h) => { const r = api.testHooks.toRange(doc, h); return `${r.start.line}-${r.end.line}:${h.labels.join('+')}`; });
    assert.deepStrictEqual(got, ['0-0:Exercise 2', '1-1:Exercise 2+Exercise 3']);
  });

  await check('inbox requests without a label are ignored', async () => {
    const f = path.join(root(), 'nolabel.py');
    fs.writeFileSync(f, 'a = 1\n');
    fs.writeFileSync(path.join(home, 'inbox', '000000000000009-t.json'), JSON.stringify({ file: f, labels: [], blocks: [{ line: 0, text: 'a = 1' }] }));
    await api.testHooks.inbox.flush();
    const doc = await vscode.workspace.openTextDocument(f);
    await sleep(300);
    assert.strictEqual(api.testHooks.highlights(doc).length, 0);
  });

  require('fs').writeFileSync(path.join(require('os').tmpdir(), 'color-focus-results.txt'), results.join('\n') + '\n');
};
