const vscode = require('vscode');
const R = require('./ranges');
const { createFolding } = require('./folding');
const { createBlocksView } = require('./blocksView');
const { createBulk } = require('./bulk');
const D = require('./linediff');
const { createSnapshots } = require('./snapshots');
const { createInbox } = require('./inbox');
const claude = require('./claude');

const STORAGE_KEY = 'colorFocus.highlights';

/** uri string -> [{ id, start, end, color, labels? }] */
let store = {};
/** null = off, otherwise { kind: 'all' } | { kind: 'color', value } | { kind: 'label', value } */
let focus = null;

const decorationTypes = new Map(); // color -> TextEditorDecorationType
let dimDecoration;
let labelDecoration;
let statusItem;
let context;
let saveTimer;
let folding;
let blocks;
/** Jump mode: after a jump, plain ↓/↑ keep jumping until the cursor moves any other way. */
let jumping = false;
let jumpTarget = null;
let jumpStatus;
let bulk;
/** Remembers the text the stored offsets refer to, so edits made outside VS Code can be followed. */
let snapshots;
let inbox;
const testHooks = {}; // lets the integration test reach the open label picker

// ---------- setup ----------

function activate(ctx) {
  context = ctx;
  store = ctx.globalState.get(STORAGE_KEY, {});
  // Highlights saved by older versions have no id yet.
  // Older versions saved no id and a single `label`; upgrade them.
  for (const [key, list] of Object.entries(store)) {
    store[key] = list.map((h) => {
      const up = 'label' in h ? R.withLabels(h, R.labelsOf(h)) : h;
      return up.id ? up : { ...up, id: R.newId() };
    });
  }


  snapshots = createSnapshots(ctx.globalStorageUri.fsPath);
  bulk = createBulk({
    entries: () => Object.entries(store),
    replace: replaceEntries,
    colorName,
    swatch: R.swatch,
    onLabelRenamed: (from, to) => {
      if (focus && focus.kind === 'label' && focus.value === from) focus = { kind: 'label', value: to };
    },
  });
  testHooks.bulk = bulk;
  testHooks.highlights = getHighlights;
  testHooks.toRange = toRange;
  testHooks.focus = () => focus;
  testHooks.jumping = () => jumping;
  testHooks.setFocus = (f) => setFocus(f);
  testHooks.releaseText = (doc) => snapshots.release(doc.uri.toString(), (key) => !!store[key]);
  folding = createFolding({ getHighlights, toRange, enabled: () => config().get('foldable', true) });
  blocks = createBlocksView({
    entries: () => Object.entries(store),
    toRange,
    colorName,
    swatch: R.swatch,
    decorationFor,
    clearOtherColors: (editor, keep) => {
      for (const [color, type] of decorationTypes) if (!keep.has(color)) editor.setDecorations(type, []);
    },
  });

  createSharedDecorations();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  const cmd = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('colorFocus.highlight', highlightSelection);
  cmd('colorFocus.setLabel', setLabelAtCursor);
  cmd('colorFocus.removeAtCursor', removeAtCursor);
  cmd('colorFocus.clearFile', clearFile);
  cmd('colorFocus.focus', pickFocus);
  cmd('colorFocus.exitFocus', () => setFocus(null));
  cmd('colorFocus.next', () => jump(1));
  cmd('colorFocus.previous', () => jump(-1));
  cmd('colorFocus.stopJumping', () => setJumping(false));
  cmd('colorFocus.list', listHighlights);
  cmd('colorFocus.showBlocks', (args) => blocks.pick(args));
  cmd('colorFocus.removeInFolder', (arg) => bulk.removeInFolder(arg));
  cmd('colorFocus.renameLabel', (arg) => bulk.renameLabel(arg));
  cmd('colorFocus.goToSource', () => blocks.goToSource());
  cmd('colorFocus.openSource', (uri, line) => blocks.openSource(uri, line));
  cmd('colorFocus.foldAll', () => folding.setFolded(true));
  cmd('colorFocus.unfoldAll', () => folding.setFolded(false));
  cmd('colorFocus.toggleFold', () => folding.toggleAtCursor());
  cmd('colorFocus.setUpClaude', () => claude.setUp(ctx, 'claude'));
  cmd('colorFocus.setUpCodex', () => claude.setUp(ctx, 'codex'));

  ctx.subscriptions.push(
    statusItem,
    { dispose: disposeDecorations },
    blocks,
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      folding.forget(doc);
      // Saved to disk; when the file is opened again, catchUp compares it with what's on disk then.
      snapshots.release(doc.uri.toString(), (key) => !!store[key]);
    }),
    vscode.workspace.onDidOpenTextDocument(catchUp),
    // Leave jump mode as soon as the cursor moves any other way, the text changes, or the tab changes.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!jumping) return;
      const sel = e.selections;
      if (sel.length !== 1 || !sel[0].isEmpty || !jumpTarget || !sel[0].active.isEqual(jumpTarget)) setJumping(false);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (jumping && e.contentChanges.length && e.document.uri.scheme !== 'colorfocus-blocks') setJumping(false);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => setJumping(false)),
    { dispose: () => jumpStatus && jumpStatus.dispose() },
    vscode.workspace.onDidChangeTextDocument(onTextChange),
    vscode.workspace.onDidRenameFiles(onRename),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('colorFocus')) return;
      disposeDecorations();
      createSharedDecorations();
      refreshAll();
      folding.sync();
    })
  );

  vscode.commands.executeCommand('setContext', 'colorFocus.focusActive', false);
  for (const doc of vscode.workspace.textDocuments) catchUp(doc);
  refreshAll();

  // Highlights sent by Claude Code, Codex (or anything else) through ~/.color-focus/inbox.
  inbox = createInbox({ addBlocks, colorForLabels });
  ctx.subscriptions.push(inbox);
  testHooks.inbox = inbox;
  claude.refreshInstalledScripts(ctx);
  return { testHooks };
}

function deactivate() {
  flushSave();
}

function config() {
  return vscode.workspace.getConfiguration('colorFocus');
}

// ---------- storage ----------

function getHighlights(doc) {
  return store[doc.uri.toString()] || [];
}

function setHighlights(doc, list) {
  const key = doc.uri.toString();
  if (list.length) store[key] = list;
  else delete store[key];
  snapshots.update(key, doc.getText());
  scheduleSave();
  refreshDocument(doc);
  folding.sync();
  blocks.refresh();
}

/** Replace the highlights of many files at once (bulk remove / rename / undo). */
function replaceEntries(changes) {
  for (const [key, list] of Object.entries(changes)) {
    if (list.length) store[key] = list;
    else delete store[key];
  }
  scheduleSave();
  refreshAll();
  folding.sync();
  blocks.refresh();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (context) context.globalState.update(STORAGE_KEY, store);
  if (snapshots) snapshots.flush((key) => !!store[key]);
}

// ---------- tracking edits ----------

function onTextChange(e) {
  const doc = e.document;
  const key = doc.uri.toString();
  let list = store[key];
  if (!list || !e.contentChanges.length) return;
  const text = doc.getText();
  const before = snapshots.get(key);

  if (before !== undefined && !doc.isDirty) {
    // Reloaded from disk after a change outside VS Code (e.g. Claude Code, git), or undone back to the saved file.
    // VS Code reports that as one big replacement, so compare the old and new text line by line instead.
    list = D.remapByDiff(list, before, text);
  } else {
    // VS Code orders multiple changes from the bottom of the file up, so applying them one by one is safe.
    for (const c of e.contentChanges) {
      list = R.applyChange(list, c.rangeOffset, c.rangeLength, c.text.length);
    }
  }
  if (list.length) store[key] = list;
  else delete store[key];
  snapshots.update(key, text);
  scheduleSave();
  refreshDocument(doc);
  folding.onEdited(doc);
  blocks.refresh();
}

/** A file was opened: if it changed on disk since its highlights were saved, move them along. */
function catchUp(doc) {
  const key = doc.uri.toString();
  const list = store[key];
  if (!list || snapshots.has(key)) return;
  const saved = snapshots.get(key); // read from disk
  const text = doc.getText();
  if (saved !== undefined && saved !== text) {
    const moved = D.remapByDiff(list, saved, text);
    if (moved.length) store[key] = moved;
    else delete store[key];
    scheduleSave();
    refreshDocument(doc);
    blocks.refresh();
  }
  snapshots.update(key, text);
}

/**
 * Highlight blocks of lines given by their text (from the inbox). Each block is found near
 * its line number hint, so it lands right even if the file moved a bit since.
 */
async function addBlocks(doc, blocksToAdd, color, labels) {
  if (!labels.length) return 0; // highlights from Claude Code (or other programs) always have a label
  catchUp(doc);
  let list = getHighlights(doc);
  let added = 0;
  for (const b of blocksToAdd) {
    const lines = String(b.text).split('\n');
    const first = D.findLines(doc.getText(), lines, b.line || 0);
    if (first < 0) continue;
    const last = first + lines.length - 1;
    list = R.addLabeled(list, doc.offsetAt(new vscode.Position(first, 0)), doc.offsetAt(doc.lineAt(last).range.end), color, labels);
    added++;
  }
  if (added) setHighlights(doc, list);
  return added;
}

/** The color already used for this label anywhere, otherwise a palette color no other label uses yet. */
function colorForLabels(labels) {
  const all = Object.values(store).flat();
  for (const l of labels) {
    const h = all.find((x) => R.labelsOf(x).includes(l));
    if (h) return h.color;
  }
  const used = new Set(all.filter((x) => R.labelsOf(x).length).map((x) => x.color));
  const colors = palette().map((p) => p.color).filter((c) => !/^#9e9e9e$/i.test(c));
  const free = colors.find((c) => !used.has(c));
  if (free) return free;
  const name = labels.join(',');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function onRename(e) {
  for (const { oldUri, newUri } of e.files) {
    const oldKey = oldUri.toString();
    const prefix = oldKey.endsWith('/') ? oldKey : oldKey + '/';
    for (const key of Object.keys(store)) {
      // Handles the file itself and, when a folder is renamed, every file inside it.
      if (key === oldKey || key.startsWith(prefix)) {
        const newKey = newUri.toString() + key.slice(oldKey.length);
        store[newKey] = store[key];
        delete store[key];
        snapshots.rename(key, newKey);
      }
    }
  }
  scheduleSave();
  refreshAll();
}

// ---------- decorations ----------

function decorationFor(color) {
  let type = decorationTypes.get(color);
  if (!type) {
    const cfg = config();
    type = vscode.window.createTextEditorDecorationType({
      backgroundColor: R.toBackground(color, cfg.get('backgroundOpacity', 0.22)),
      isWholeLine: cfg.get('wholeLine', true),
      overviewRulerColor: cfg.get('showInOverviewRuler', true) ? color : undefined,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    decorationTypes.set(color, type);
  }
  return type;
}

function createSharedDecorations() {
  dimDecoration = vscode.window.createTextEditorDecorationType({
    opacity: String(config().get('dimOpacity', 0.2)),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  // The label text itself is set per highlight in renderEditor.
  labelDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2.5em', fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

function disposeDecorations() {
  for (const t of decorationTypes.values()) t.dispose();
  decorationTypes.clear();
  if (dimDecoration) dimDecoration.dispose();
  if (labelDecoration) labelDecoration.dispose();
}

function refreshAll() {
  for (const editor of vscode.window.visibleTextEditors) renderEditor(editor);
  updateStatus();
}

function refreshDocument(doc) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === doc) renderEditor(editor);
  }
  updateStatus();
}

function toRange(doc, h) {
  const len = doc.getText().length;
  const start = Math.min(h.start, len);
  const end = Math.min(h.end, len);
  let startPos = doc.positionAt(start);
  let endPos = doc.positionAt(end);
  // Starting at the very end of a line means "from the next line" (left over after removing/re-coloring lines above).
  if (startPos.line < endPos.line && startPos.character === doc.lineAt(startPos.line).text.length && startPos.character > 0) {
    startPos = new vscode.Position(startPos.line + 1, 0);
  }
  // Ending at column 0 means "up to the previous line break"; don't spill onto the next line.
  if (endPos.character === 0 && endPos.line > startPos.line) {
    endPos = doc.lineAt(endPos.line - 1).range.end;
  }
  return new vscode.Range(startPos, endPos);
}

function inFocus(h) {
  if (!focus || focus.kind === 'all') return true;
  if (focus.kind === 'color') return h.color === focus.value;
  return R.labelsOf(h).includes(focus.value);
}

/** "◆ a  ◆ b" */
function labelText(h) {
  return R.labelsOf(h).map((l) => `◆ ${l}`).join('  ');
}

function hoverFor(h) {
  const md = new vscode.MarkdownString();
  const names = R.labelsOf(h).map((l) => `**${escapeMd(l)}**`).join(' · ');
  md.appendMarkdown(`${names} — ${escapeMd(colorName(h.color))}\n\n`);
  md.appendMarkdown('[Add/remove labels](command:colorFocus.setLabel) · [Focus on a label](command:colorFocus.focus)');
  md.isTrusted = { enabledCommands: ['colorFocus.setLabel', 'colorFocus.focus'] };
  return md;
}

function escapeMd(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function renderEditor(editor) {
  if (blocks.render(editor)) return; // the stacked "blocks only" view draws itself
  const doc = editor.document;
  const list = getHighlights(doc);
  const visible = list.filter(inFocus); // in focus mode, other highlights are hidden

  // Backgrounds, grouped by color. Labeled blocks also get a hover.
  const byColor = new Map();
  for (const h of visible) {
    if (!byColor.has(h.color)) byColor.set(h.color, []);
    const range = toRange(doc, h);
    byColor.get(h.color).push(R.labelsOf(h).length ? { range, hoverMessage: hoverFor(h) } : { range });
  }
  for (const [color, type] of decorationTypes) {
    if (!byColor.has(color)) editor.setDecorations(type, []);
  }
  for (const [color, options] of byColor) {
    editor.setDecorations(decorationFor(color), options);
  }

  // Label text at the end of each block's first line.
  const labels = [];
  if (config().get('showLabels', true)) {
    for (const h of visible) {
      if (!R.labelsOf(h).length) continue;
      const line = doc.lineAt(toRange(doc, h).start.line);
      labels.push({
        range: new vscode.Range(line.range.end, line.range.end),
        renderOptions: { after: { contentText: labelText(h), color: h.color } },
      });
    }
  }
  editor.setDecorations(labelDecoration, labels);

  editor.setDecorations(dimDecoration, focus ? dimRanges(doc, visible) : []);
}

/** Everything outside the focused highlights. */
function dimRanges(doc, focused) {
  if (config().get('wholeLine', true)) {
    // Work in whole lines so a highlighted line is never half dimmed.
    const lines = focused.map((h) => {
      const r = toRange(doc, h);
      return { start: r.start.line, end: r.end.line + 1 };
    });
    return R.complement(lines, doc.lineCount).map(
      (g) => new vscode.Range(g.start, 0, g.end - 1, doc.lineAt(g.end - 1).range.end.character)
    );
  }
  const total = doc.getText().length;
  return R.complement(focused, total).map(
    (g) => new vscode.Range(doc.positionAt(g.start), doc.positionAt(g.end))
  );
}

// ---------- status bar ----------

function updateStatus() {
  const editor = vscode.window.activeTextEditor;
  if (focus) {
    statusItem.text = `$(eye) Focus: ${focusTitle(focus)}`;
    statusItem.tooltip = 'Color Focus is on. Click to show all code again.';
    statusItem.command = 'colorFocus.exitFocus';
    statusItem.show();
    return;
  }
  const count = editor ? getHighlights(editor.document).length : 0;
  if (count) {
    statusItem.text = `$(symbol-color) ${count}`;
    statusItem.tooltip = `${count} highlight${count === 1 ? '' : 's'} in this file. Click to focus.`;
    statusItem.command = 'colorFocus.focus';
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

// ---------- colors and labels ----------

function palette() {
  return config().get('colors', []).filter((c) => c && c.color);
}

function colorName(color) {
  const found = palette().find((c) => c.color.toLowerCase() === String(color).toLowerCase());
  return found ? found.name : color;
}

function focusTitle(f) {
  if (f.kind === 'all') return 'All highlights';
  if (f.kind === 'color') return colorName(f.value);
  return `◆ ${f.value}`;
}

async function pickColor() {
  const items = palette().map((c) => ({
    label: `${R.swatch(c.color)}  ${c.name}`,
    description: c.color,
    color: c.color,
  }));
  items.push({ label: '$(add)  Custom color…', description: 'hex, rgb() or any CSS color', custom: true });

  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a background color' });
  if (!choice) return undefined;
  if (!choice.custom) return choice.color;

  const value = await vscode.window.showInputBox({
    prompt: 'Enter a color, e.g. #ff8800, rgb(255,136,0) or rgba(255,136,0,0.3)',
    validateInput: (v) =>
      /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/i.test(v.trim()) ? null : 'Not a recognised CSS color',
  });
  return value ? value.trim() : undefined;
}

/** Every label used in any file, most used first. Used as suggestions. */
function knownLabels() {
  const counts = new Map();
  for (const list of Object.values(store)) {
    for (const h of list) for (const l of R.labelsOf(h)) counts.set(l, (counts.get(l) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}

/**
 * Checklist of labels. Type a name + Enter to add it (commas add several at once),
 * or Enter on an existing label to tick/untick it. Enter on an empty box (or OK) finishes.
 * Returns the chosen labels ([] = none), or undefined if cancelled.
 */
function askLabels(current = []) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    testHooks.labelPicker = qp;
    qp.canSelectMany = true;
    qp.matchOnDescription = false;
    const chosen = new Set(current);
    const all = [...new Set([...current, ...knownLabels()])];
    let rebuilding = false;
    const titleFor = (set) => `${set.size ? `Labels: ${[...set].join(', ')}` : 'Labels (optional)'} — press Enter on an empty box when done`;

    const build = () => {
      rebuilding = true;
      const typed = R.normalizeLabels(qp.value, true);
      const items = [];
      const isNew = typed.length && !(typed.length === 1 && all.some((l) => l.toLowerCase() === typed[0].toLowerCase()));
      if (isNew) {
        items.push({ label: qp.value.trim(), description: typed.length > 1 ? `add ${typed.length} new labels` : 'new label — press Enter to add', iconPath: new vscode.ThemeIcon('add'), newLabels: typed, alwaysShow: true });
      }
      // Ticked labels first, then the rest.
      const ordered = [...all.filter((l) => chosen.has(l)), ...all.filter((l) => !chosen.has(l))];
      for (const l of ordered) items.push({ label: l, iconPath: new vscode.ThemeIcon('tag'), value: l });
      qp.items = items;
      qp.selectedItems = items.filter((i) => i.value !== undefined && chosen.has(i.value));
      qp.title = titleFor(chosen);
      qp.placeholder = all.length ? 'Type a new label + Enter, or tick existing ones' : 'Type a label + Enter (commas for several)';
      rebuilding = false;
    };

    qp.onDidChangeValue(build);
    qp.onDidChangeSelection((sel) => {
      if (rebuilding) return;
      // Checkbox clicks: mirror visible items' state into `chosen`.
      const visible = new Set(sel.map((i) => i.value));
      for (const i of qp.items) {
        if (i.value === undefined) continue;
        if (visible.has(i.value)) chosen.add(i.value);
        else if (matchesFilter(i.label, qp.value)) chosen.delete(i.value);
      }
      qp.title = titleFor(chosen);
    });

    let done = false;
    qp.onDidAccept(() => {
      if (qp.value.trim()) {
        // In checklist mode nothing is "active" until you use the arrow keys.
        const typed = R.normalizeLabels(qp.value, true);
        const exact = typed.length === 1 && all.find((l) => l.toLowerCase() === typed[0].toLowerCase());
        const active = qp.activeItems[0];
        const toggle = active && active.value !== undefined ? active.value : !active || !active.newLabels ? exact : undefined;
        if (toggle) {
          if (chosen.has(toggle)) chosen.delete(toggle);
          else chosen.add(toggle);
        } else {
          for (const l of typed) {
            chosen.add(l);
            if (!all.includes(l)) all.push(l);
          }
        }
        qp.value = ''; // fires build()
        build();
        return;
      }
      done = true;
      resolve([...chosen]);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    build();
    qp.show();
  });
}

/** Rough check whether VS Code's quick pick filter shows an item for this text (hidden items keep their tick). */
function matchesFilter(label, filter) {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  let i = 0;
  for (const ch of label.toLowerCase()) if (ch === f[i]) i++;
  return i >= f.replace(/\s/g, '').length || label.toLowerCase().includes(f);
}

// ---------- commands ----------

/** args (optional, e.g. from a keybinding): { color, label | labels } skips the pickers. */
async function highlightSelection(args) {
  args = args && typeof args === 'object' && !(args instanceof vscode.Uri) ? args : {};
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  const targets = editor.selections.map((sel) => selectionOffsets(doc, sel)).filter(Boolean);
  if (!targets.length) {
    vscode.window.showInformationMessage('Color Focus: select some code first.');
    return;
  }

  const color = args.color || (await pickColor());
  if (!color) return;

  const given = args.labels !== undefined ? args.labels : args.label;
  let labels = R.normalizeLabels(given);
  if (given === undefined && !args.color && config().get('askForLabel', true)) {
    labels = await askLabels();
    if (labels === undefined) return;
  }

  let list = getHighlights(doc);
  for (const t of targets) list = R.addHighlight(list, t.start, t.end, color, labels);
  setHighlights(doc, list);
}

/** Offsets for a selection; expanded to full lines when wholeLine is on. */
function selectionOffsets(doc, sel) {
  if (!config().get('wholeLine', true)) {
    if (sel.isEmpty) return null;
    return { start: doc.offsetAt(sel.start), end: doc.offsetAt(sel.end) };
  }
  let endLine = sel.end.line;
  // A selection ending at the very start of a line shouldn't include that line.
  if (!sel.isEmpty && sel.end.character === 0 && endLine > sel.start.line) endLine--;
  const start = doc.lineAt(sel.start.line).range.start;
  const end = doc.lineAt(endLine).range.end;
  const startOff = doc.offsetAt(start);
  let endOff = doc.offsetAt(end);
  if (endOff === startOff) endOff = startOff + Math.min(1, doc.getText().length - startOff); // empty line
  if (endOff <= startOff) return null;
  return { start: startOff, end: endOff };
}

/** Does the highlight cover this cursor position? */
function covers(doc, h, pos) {
  if (config().get('wholeLine', true)) {
    const r = toRange(doc, h);
    return pos.line >= r.start.line && pos.line <= r.end.line;
  }
  const off = doc.offsetAt(pos);
  return off >= h.start && off <= h.end;
}

async function setLabelAtCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const list = getHighlights(doc);
  const pos = editor.selection.active;
  const hit = list.filter((h) => inFocus(h) && covers(doc, h, pos));
  if (!hit.length) {
    vscode.window.showInformationMessage('Color Focus: put the cursor inside a highlight to label it.');
    return;
  }

  const labels = await askLabels(R.labelsOf(hit[0]));
  if (labels === undefined) return;
  setHighlights(doc, list.map((h) => (hit.includes(h) ? R.withLabels(h, labels) : h)));
}

function removeAtCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  let list = getHighlights(doc);
  const before = list.length;
  let erased = false;

  for (const sel of editor.selections) {
    if (!sel.isEmpty) {
      // With a selection: erase color only from the selected part.
      const t = selectionOffsets(doc, sel);
      if (t) list = R.subtract(list, t.start, t.end);
      erased = true;
    } else {
      // No selection: remove the whole highlight under the cursor.
      list = list.filter((h) => !covers(doc, h, sel.active));
    }
  }

  if (!erased && list.length === before) {
    vscode.window.showInformationMessage('Color Focus: no highlight at the cursor.');
    return;
  }
  setHighlights(doc, list);
}

async function clearFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !getHighlights(editor.document).length) return;
  const answer = await vscode.window.showWarningMessage(
    'Remove all highlights in this file?',
    { modal: true },
    'Remove all'
  );
  if (answer === 'Remove all') setHighlights(editor.document, []);
}

async function pickFocus() {
  const editor = vscode.window.activeTextEditor;
  const list = editor ? getHighlights(editor.document) : [];
  if (!list.length) {
    vscode.window.showInformationMessage('Color Focus: this file has no highlights yet. Select code and run "Highlight Selection With Color…".');
    return;
  }

  const colorCounts = new Map();
  const labelCounts = new Map();
  const labelColor = new Map();
  for (const h of list) {
    colorCounts.set(h.color, (colorCounts.get(h.color) || 0) + 1);
    for (const l of R.labelsOf(h)) {
      labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
      if (!labelColor.has(l)) labelColor.set(l, h.color);
    }
  }
  const blocks = (n) => `${n} block${n === 1 ? '' : 's'}`;

  const items = [];
  if (list.length > 1) items.push({ label: '$(eye)  All highlights', description: blocks(list.length), focus: { kind: 'all' } });
  items.push({ label: 'Colors', kind: vscode.QuickPickItemKind.Separator });
  for (const [color, n] of colorCounts) {
    items.push({ label: `${R.swatch(color)}  ${colorName(color)}`, description: blocks(n), focus: { kind: 'color', value: color } });
  }
  if (labelCounts.size) {
    items.push({ label: 'Labels', kind: vscode.QuickPickItemKind.Separator });
    for (const [label, n] of labelCounts) {
      items.push({ label: `◆  ${label}`, description: `${blocks(n)} · ${colorName(labelColor.get(label))}`, focus: { kind: 'label', value: label } });
    }
  }

  // If the cursor is in a labeled block, offer that label first.
  // If the cursor is in a labeled block, offer its labels first.
  const here = editor && list.find((h) => R.labelsOf(h).length && covers(editor.document, h, editor.selection.active));
  if (here) {
    for (const l of [...R.labelsOf(here)].reverse()) {
      const item = items.find((i) => i.focus && i.focus.kind === 'label' && i.focus.value === l);
      if (item) {
        items.splice(items.indexOf(item), 1);
        items.unshift(item);
      }
    }
  }

  const choices = items.filter((i) => i.focus);
  const choice = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Show only this' });
  if (choice) setFocus(choice.focus);
}

function setFocus(f) {
  focus = f;
  vscode.commands.executeCommand('setContext', 'colorFocus.focusActive', !!f);
  refreshAll();
}

function sortedVisible(doc) {
  return getHighlights(doc)
    .filter(inFocus)
    .sort((a, b) => a.start - b.start);
}

function jump(direction) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  // Line spans of the blocks to jump between: stacked view uses its own blocks.
  const spans =
    doc.uri.scheme === blocks.SCHEME
      ? blocks.spans(doc)
      : sortedVisible(doc).map((h) => {
          const r = toRange(doc, h);
          return { start: r.start.line, end: r.end.line };
        });
  if (!spans.length) {
    vscode.window.setStatusBarMessage('$(info) Color Focus: no highlights here', 2500);
    return;
  }

  const line = editor.selection.active.line;
  const inside = spans.findIndex((s) => line >= s.start && line <= s.end);
  let index;
  if (direction > 0) {
    index = spans.findIndex((s) => s.start > line);
  } else if (inside > 0 || (inside === 0 && line !== spans[0].start)) {
    // Inside a block: go to the block before it. In the first block, go to its top line first.
    index = inside === 0 ? 0 : inside - 1;
  } else if (inside === 0) {
    index = -1;
  } else {
    index = spans.map((s, i) => [s.start, i]).filter(([start]) => start < line).map(([, i]) => i).pop();
  }
  if (index === undefined || index === -1) index = direction > 0 ? 0 : spans.length - 1; // wrap around

  const target = new vscode.Position(spans[index].start, 0);
  jumpTarget = target;
  setJumping(true);
  editor.selection = new vscode.Selection(target, target);
  editor.revealRange(new vscode.Range(spans[index].start, 0, spans[index].end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  showJumpStatus(`Highlight ${index + 1} of ${spans.length}`);
}

function setJumping(on) {
  if (jumping === on) return;
  jumping = on;
  vscode.commands.executeCommand('setContext', 'colorFocus.jumping', on);
  if (!on) {
    jumpTarget = null;
    if (jumpStatus) jumpStatus.dispose();
    jumpStatus = undefined;
  }
}

function showJumpStatus(text) {
  if (jumpStatus) jumpStatus.dispose();
  jumpStatus = vscode.window.setStatusBarMessage(`$(symbol-color) ${text} · ↓/↑ keep jumping · any other key stops`);
}

function reveal(editor, h) {
  const range = toRange(editor.document, h);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function listHighlights() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const list = sortedVisible(doc);
  if (!list.length) {
    vscode.window.showInformationMessage('Color Focus: no highlights in this file.');
    return;
  }
  const items = list.map((h) => {
    const r = toRange(doc, h);
    const lines = r.start.line === r.end.line ? `line ${r.start.line + 1}` : `lines ${r.start.line + 1}–${r.end.line + 1}`;
    const code = doc.lineAt(r.start.line).text.trim() || '(empty line)';
    return {
      label: `${R.swatch(h.color)}  ${R.labelsOf(h).length ? labelText(h) : code}`,
      description: `${colorName(h.color)} · ${lines}`,
      detail: R.labelsOf(h).length ? code : undefined,
      h,
    };
  });
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Jump to a highlight (type to search labels, colors or code)',
    matchOnDescription: true,
    matchOnDetail: true,
    onDidSelectItem: (item) => reveal(editor, item.h), // preview while moving through the list
  });
  if (choice) reveal(editor, choice.h);
}

module.exports = { activate, deactivate };
