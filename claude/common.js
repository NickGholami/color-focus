// Shared by the Claude Code hook and the color-focus command.
// Installed to ~/.color-focus/bin by "Color Focus: Set Up Claude Code Integration".

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const D = require(fs.existsSync(path.join(__dirname, 'linediff.js')) ? './linediff.js' : '../src/linediff.js');

const HOME = process.env.COLOR_FOCUS_HOME || path.join(os.homedir(), '.color-focus');
const ACTIVE = path.join(HOME, 'active.json');
const INBOX = path.join(HOME, 'inbox');
const BEFORE = path.join(HOME, 'before');
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // a forgotten label stops after 12 hours

/** The label Claude is working under right now, or null. */
function readActive() {
  try {
    const a = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    if (!a.label || Date.now() - (a.started || 0) > MAX_AGE_MS) return null;
    return a;
  } catch {
    return null;
  }
}

/** Resolve symlinks (e.g. /var -> /private/var on macOS), also for files that don't exist yet. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

function inside(file, dir) {
  if (!dir) return true;
  const rel = path.relative(real(dir), real(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Ask the extension to highlight these 0-based, inclusive line blocks of `file`. */
function sendBlocks(file, text, blocks, labels, color) {
  if (!blocks.length) return 0;
  const lines = D.splitLines(text).lines;
  const req = {
    file,
    labels,
    blocks: blocks.map((b) => ({ line: b.start, text: lines.slice(b.start, b.end + 1).join('\n') })),
  };
  if (color) req.color = color;
  fs.mkdirSync(INBOX, { recursive: true });
  // Write to a temp name first so the extension never reads half a file.
  const name = `${Date.now().toString().padStart(15, '0')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(INBOX, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(req));
  fs.renameSync(tmp, path.join(INBOX, name + '.json'));
  return blocks.length;
}

module.exports = { D, HOME, ACTIVE, INBOX, BEFORE, readActive, inside, sendBlocks };
