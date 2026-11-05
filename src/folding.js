// Folding highlighted blocks.
//
// Why "manual" folding ranges: normal folding ranges from a FoldingRangeProvider must nest
// inside each other, so a block that starts inside a function and ends after it would be
// dropped. Registering a provider for every language would also switch off VS Code's
// indentation-based folding (e.g. Python). Manual folding ranges (the ones from
// "Create Folding Range from Selection") have neither problem and move with edits.
//
// They can only be made through editor commands, which collapse the range right away and
// use the cursor. So a block's fold is only created when you ask to fold it (no jerking
// when highlights are added). After that it keeps its arrow in the gutter.

const vscode = require('vscode');

function createFolding({ getHighlights, toRange, enabled }) {
  /** uri -> Map(id -> { start, end }): blocks that have a fold, and its line span */
  const created = new Map();
  let queue = Promise.resolve();

  const enqueue = (fn) => (queue = queue.then(fn, fn));

  function spanOf(doc, h) {
    const r = toRange(doc, h);
    return { start: r.start.line, end: r.end.line };
  }

  /** Text was edited: folds move with the text by themselves, so just record where they are now. */
  function onEdited(doc) {
    const made = created.get(doc.uri.toString());
    if (!made) return;
    const byId = new Map(getHighlights(doc).map((h) => [h.id, h]));
    for (const id of [...made.keys()]) {
      if (byId.has(id)) made.set(id, spanOf(doc, byId.get(id)));
      else made.delete(id); // block deleted together with its text
    }
  }

  function forget(doc) {
    created.delete(doc.uri.toString());
  }

  /**
   * Highlights changed: remove folds of blocks that are gone or changed shape.
   * Only does anything if such a block had been folded before.
   */
  function sync() {
    return enqueue(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const made = created.get(doc.uri.toString());
      if (!made || !made.size) return;

      const byId = new Map(getHighlights(doc).map((h) => [h.id, h]));
      const stale = [...made].filter(([id, span]) => {
        const h = byId.get(id);
        if (!h) return true;
        const now = spanOf(doc, h);
        return now.start !== span.start || now.end !== span.end;
      });
      if (!stale.length) return;

      const selections = editor.selections;
      for (const [id, span] of stale) {
        editor.selection = new vscode.Selection(span.start, 0, span.end, 0);
        await vscode.commands.executeCommand('editor.removeManualFoldingRanges');
        made.delete(id);
        // That also removed any other manual fold touching these lines.
        for (const [other, s] of [...made]) if (s.start <= span.end && s.end >= span.start) made.delete(other);
      }
      if (vscode.window.activeTextEditor === editor) editor.selections = selections;
    });
  }

  function foldable(doc, h) {
    const s = spanOf(doc, h);
    return s.end > s.start; // one-line blocks can't fold
  }

  function isFolded(editor, span) {
    // Folded = the block's first line is visible but the line after it is hidden.
    const visible = (line) => editor.visibleRanges.some((r) => line >= r.start.line && line <= r.end.line);
    return visible(span.start) && !visible(span.start + 1);
  }

  /** Fold (true), unfold (false) or toggle (undefined) the given blocks in the active editor. */
  function setFolded(folded, highlights) {
    return enqueue(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !enabled()) return;
      const doc = editor.document;
      const key = doc.uri.toString();
      if (!created.has(key)) created.set(key, new Map());
      const made = created.get(key);

      const list = (highlights || getHighlights(doc)).filter((h) => foldable(doc, h));
      if (!list.length) return;
      const cursor = editor.selection.active;
      let cursorHidden = null;

      // Outer blocks first so folding by start line hits the right fold.
      const spans = list.map((h) => [h, spanOf(doc, h)]).sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end);
      const fold = folded === undefined ? !spans.some(([, s]) => isFolded(editor, s)) : folded;

      for (const [h, span] of spans) {
        const known = made.get(h.id);
        const hasFold = known && known.start === span.start && known.end === span.end;
        if (fold) {
          if (hasFold) {
            await vscode.commands.executeCommand('editor.fold', { selectionLines: [span.start], levels: 1 });
          } else {
            // Creating the fold also collapses it, which is what we want here.
            editor.selection = new vscode.Selection(span.start, 0, span.end, doc.lineAt(span.end).text.length);
            await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
            made.set(h.id, span);
          }
          if (cursor.line > span.start && cursor.line <= span.end) cursorHidden = span.start;
        } else if (hasFold) {
          await vscode.commands.executeCommand('editor.unfold', { selectionLines: [span.start], levels: 1 });
        }
      }

      // Put the cursor back; if it was inside a block we just folded, put it on that block's first line.
      if (vscode.window.activeTextEditor === editor) {
        const pos = cursorHidden !== null ? new vscode.Position(cursorHidden, 0) : cursor;
        editor.selection = new vscode.Selection(pos, pos);
      }
    });
  }

  /** Fold/unfold the block the cursor is in. */
  function toggleAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const line = editor.selection.active.line;
    const here = getHighlights(doc).filter((h) => {
      const s = spanOf(doc, h);
      return line >= s.start && line <= s.end;
    });
    if (!here.length) {
      vscode.window.setStatusBarMessage('$(info) Color Focus: the cursor is not in a highlighted block', 2500);
      return;
    }
    if (!here.some((h) => foldable(doc, h))) {
      vscode.window.setStatusBarMessage('$(info) Color Focus: one-line blocks can\'t be folded', 2500);
      return;
    }
    return setFolded(undefined, here);
  }

  return { sync, onEdited, forget, setFolded, toggleAtCursor, idle: () => queue };
}

module.exports = { createFolding };
