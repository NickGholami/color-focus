#!/usr/bin/env node
// Hook for Claude Code (PreToolUse + PostToolUse on Edit/Write/MultiEdit) and
// Codex (PreToolUse + PostToolUse on apply_patch and Bash).
// While a label is active (`color-focus start "Exercise 1"`), every block of code the agent adds or
// changes is sent to the Color Focus extension and highlighted with that label.
//
// Before an edit it saves the file's current text; after the edit it compares old and new line by
// line to find exactly which lines changed. It never blocks or slows the agent down: any problem is ignored.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { D, BEFORE, readActive, inside, sendBlocks, markHandled, colorFocusCalls } = require('./common');

const CLAUDE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const SHELL_TOOLS = ['Bash', 'shell', 'exec_command', 'local_shell'];

function main(input) {
  const ev = JSON.parse(input);
  const tool = ev.tool_name;
  const ti = ev.tool_input || {};
  const cwd = ev.cwd || process.cwd();
  const command = Array.isArray(ti.command) ? ti.command.join(' ') : String(ti.command || '');

  // Codex: carry out `color-focus start/stop/add` here, outside Codex's sandbox (see common.js).
  if (SHELL_TOOLS.includes(tool) && ev.hook_event_name === 'PreToolUse' && /color-focus/.test(command)) {
    runColorFocusCommands(command, cwd);
  }

  const active = readActive();
  if (!active) return;
  const at = (file) => (path.isAbsolute(file) ? file : path.resolve(cwd, file));

  if (CLAUDE_TOOLS.includes(tool)) {
    if (ti.file_path) claudeEdit(ev, tool, ti, at(ti.file_path), active);
  } else if (tool === 'apply_patch' || (SHELL_TOOLS.includes(tool) && command.includes('*** Begin Patch'))) {
    for (const f of patchFiles(command)) {
      codexEdit(ev, { from: at(f.from), to: at(f.to), added: f.added }, active);
    }
  }
}

function runColorFocusCommands(command, cwd) {
  const { run } = require('./color-focus.js'); // with .js: next to it is the `color-focus` shell wrapper
  for (const call of colorFocusCalls(command, cwd)) {
    if (!['start', 'stop', 'add'].includes(call.args[0])) continue;
    try {
      const result = run(call.args, call.cwd);
      if (result.code === 0) markHandled(call.args, result.out);
    } catch {}
  }
}

const savedCopy = (ev, file) =>
  path.join(BEFORE, crypto.createHash('sha1').update(`${ev.session_id || ''}\n${file}`).digest('hex') + '.json');

function saveBefore(ev, file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {} // a new file starts empty
  fs.mkdirSync(BEFORE, { recursive: true });
  fs.writeFileSync(savedCopy(ev, file), JSON.stringify({ text }));
}

/** The text saved before the edit (used up), or undefined. */
function takeBefore(ev, file) {
  const saved = savedCopy(ev, file);
  try {
    const { text } = JSON.parse(fs.readFileSync(saved, 'utf8'));
    fs.unlinkSync(saved);
    return text;
  } catch {
    return undefined;
  }
}

function claudeEdit(ev, tool, ti, file, active) {
  if (!inside(file, active.dir)) return;
  if (ev.hook_event_name === 'PreToolUse') return saveBefore(ev, file);
  if (ev.hook_event_name !== 'PostToolUse') return;

  let after;
  try { after = fs.readFileSync(file, 'utf8'); } catch { return; }
  const before = takeBefore(ev, file);

  let blocks;
  if (before !== undefined) {
    blocks = D.changedBlocks(before, after);
  } else {
    // No copy from before the edit (e.g. only the PostToolUse hook is set up): find the new text instead.
    const pieces = tool === 'Write' ? [ti.content] : tool === 'MultiEdit' ? (ti.edits || []).map((e) => e.new_string) : [ti.new_string];
    blocks = [];
    const lineAt = (offset) => after.slice(0, offset).split('\n').length - 1;
    for (const piece of pieces) {
      if (!piece || !piece.trim()) continue;
      const at = after.indexOf(piece);
      if (at >= 0) blocks.push({ start: lineAt(at), end: lineAt(at + piece.replace(/\n$/, '').length) });
    }
  }
  sendBlocks(file, after, blocks, [active.label], active.color);
}

/**
 * Files a Codex patch adds or changes: { from, to, added }. `to` differs from `from` when the file is moved.
 *   *** Begin Patch / *** Add File: a.py / *** Update File: b.py / *** Move to: c.py / *** Delete File: d.py
 */
function patchFiles(patch) {
  const files = [];
  for (const line of patch.split(/\r?\n/)) {
    let m;
    if ((m = /^\*\*\* (Add|Update) File: (.+)$/.exec(line))) {
      const p = m[2].trim();
      files.push({ from: p, to: p, added: m[1] === 'Add' });
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && files.length) {
      files[files.length - 1].to = m[1].trim();
    }
  }
  return files;
}

function codexEdit(ev, { from, to, added }, active) {
  if (!inside(to, active.dir)) return;
  if (ev.hook_event_name === 'PreToolUse') return saveBefore(ev, from);
  if (ev.hook_event_name !== 'PostToolUse') return;

  let after;
  try { after = fs.readFileSync(to, 'utf8'); } catch { return; }
  let before = takeBefore(ev, from);
  if (before === undefined && added) before = '';
  if (before === undefined) return; // no copy from before the edit: can't tell what changed
  sendBlocks(to, after, D.changedBlocks(before, after), [active.label], active.color);
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    try {
      main(input);
    } catch {
      // Never get in the agent's way.
    }
    process.exit(0);
  });
}

module.exports = { patchFiles };
