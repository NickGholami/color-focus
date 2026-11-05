// Highlights sent from outside VS Code, e.g. by the Claude Code hook.
// Other programs drop small JSON files into ~/.color-focus/inbox:
//   { "file": "/abs/path.py", "labels": ["Exercise 1"], "color": "#6bcb77" (optional),
//     "blocks": [{ "line": 12, "text": "the exact lines\nof the block" }] }
// Blocks are found by their text (nearest to `line`, 0-based), so they still land right
// if the file changed a little before VS Code got to them. Requests wait while VS Code is closed.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { homeDir } = require('./paths');
const R = require('./ranges');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createInbox({ addBlocks, colorForLabels }) {
  const dir = path.join(homeDir(), 'inbox');
  let busy = false;
  let again = false;
  let timer;
  let watcher;
  let disposed = false;
  const listeners = new Set();

  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  function schedule(ms = 150) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  try {
    watcher = fs.watch(dir, () => schedule());
  } catch {}
  const poll = setInterval(() => schedule(0), 4000); // in case a file event is missed
  schedule(500);

  function inWorkspace(file) {
    return !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  }

  async function run() {
    if (disposed) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch {}
      for (const name of names) {
        const full = path.join(dir, name);
        let req;
        try {
          req = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
          continue; // being written, or gone
        }
        // With several VS Code windows open, the window that has the file in its workspace takes it.
        // Others wait a few seconds before taking it, in case no window has it open.
        let age = 0;
        try { age = Date.now() - fs.statSync(full).mtimeMs; } catch { continue; }
        if (!req.file || (!inWorkspace(req.file) && age < 3000)) continue;
        const claimed = `${full}.${process.pid}.work`;
        try { fs.renameSync(full, claimed); } catch { continue; } // another window got it first
        try {
          await handle(req);
        } catch (e) {
          console.error('Color Focus inbox:', e);
        }
        try { fs.unlinkSync(claimed); } catch {}
      }
    } finally {
      busy = false;
      for (const l of listeners) l();
      if (again) {
        again = false;
        schedule(0);
      }
    }
  }

  async function handle(req) {
    if (!fs.existsSync(req.file)) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.file));
    // If the file was just changed on disk, wait until VS Code has loaded the new text.
    for (let i = 0; i < 30 && !doc.isDirty; i++) {
      let disk;
      try { disk = fs.readFileSync(req.file, 'utf8'); } catch { break; }
      if (disk === doc.getText()) break;
      await sleep(100);
    }
    const labels = R.normalizeLabels(req.labels || req.label);
    const color = req.color || colorForLabels(labels);
    await addBlocks(doc, Array.isArray(req.blocks) ? req.blocks : [], color, labels);
  }

  return {
    dir,
    /** For tests: resolves after the inbox has been checked. */
    flush: () => new Promise((resolve) => {
      const done = () => { listeners.delete(done); resolve(); };
      listeners.add(done);
      schedule(0);
    }),
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (watcher) watcher.close();
    },
  };
}

module.exports = { createInbox };
