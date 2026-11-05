#!/usr/bin/env node
// Claude Code hook (PreToolUse + PostToolUse on Edit/Write/MultiEdit).
// While a label is active (`color-focus start "Exercise 1"`), every block of code Claude adds or
// changes is sent to the Color Focus extension and highlighted with that label.
//
// Before an edit it saves the file's current text; after the edit it compares old and new line by
// line to find exactly which lines changed. It never blocks or slows Claude down: any problem is ignored.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { D, BEFORE, readActive, inside, sendBlocks } = require('./common');

function main(input) {
  const active = readActive();
  if (!active) return;
  const ev = JSON.parse(input);
  const tool = ev.tool_name;
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const ti = ev.tool_input || {};
  let file = ti.file_path;
  if (!file) return;
  if (!path.isAbsolute(file)) file = path.resolve(ev.cwd || process.cwd(), file);
  if (!inside(file, active.dir)) return;

  const key = crypto.createHash('sha1').update(`${ev.session_id || ''}\n${file}`).digest('hex');
  const saved = path.join(BEFORE, key + '.json');

  if (ev.hook_event_name === 'PreToolUse') {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {} // a new file starts empty
    fs.mkdirSync(BEFORE, { recursive: true });
    fs.writeFileSync(saved, JSON.stringify({ text }));
    return;
  }
  if (ev.hook_event_name !== 'PostToolUse') return;

  let after;
  try { after = fs.readFileSync(file, 'utf8'); } catch { return; }
  let before;
  try {
    before = JSON.parse(fs.readFileSync(saved, 'utf8')).text;
    fs.unlinkSync(saved);
  } catch {}

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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    main(input);
  } catch {
    // Never get in Claude's way.
  }
  process.exit(0);
});
