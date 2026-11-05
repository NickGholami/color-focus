// Shared by the hook (Claude Code and Codex) and the color-focus command.
// Installed to ~/.color-focus/bin by "Color Focus: Set Up Claude Code / Codex Integration".

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

// --- Codex: its sandbox doesn't let shell commands write to ~/.color-focus, so the hook (which runs
// outside the sandbox) carries out `color-focus start/stop/add` itself just before the command runs.
// It leaves a note here; the command then finds the note and only prints the result.

const HANDLED = path.join(HOME, 'handled');
const HANDLED_MAX_AGE_MS = 2 * 60 * 1000;
const handledFile = (args) => path.join(HANDLED, crypto.createHash('sha1').update(args.join('\0')).digest('hex') + '.json');

function markHandled(args, message) {
  fs.mkdirSync(HANDLED, { recursive: true });
  // Notes a sandboxed command couldn't delete: clear out the expired ones.
  for (const n of fs.readdirSync(HANDLED)) {
    const f = path.join(HANDLED, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs > HANDLED_MAX_AGE_MS) fs.unlinkSync(f); } catch {}
  }
  fs.writeFileSync(handledFile(args), JSON.stringify({ message, at: Date.now() }));
}

/** The message if the hook already ran exactly this command a moment ago (the note is used up), else null. */
function takeHandled(args) {
  const f = handledFile(args);
  try {
    const note = JSON.parse(fs.readFileSync(f, 'utf8'));
    try { fs.unlinkSync(f); } catch {} // read-only inside a sandbox: then it just expires
    return Date.now() - note.at < HANDLED_MAX_AGE_MS ? note.message : null;
  } catch {
    return null;
  }
}

/** Split a shell command into words and operators (; && || | & and newlines), honoring quotes. */
function shellWords(command) {
  const out = [];
  let word = null;
  const push = () => { if (word !== null) out.push(word); word = null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word = (word || '') + command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      word = word || '';
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && /["\\$`]/.test(command[i + 1] || '')) i++;
        word += command[i];
      }
    } else if (c === '\\' && command[i + 1] === '\n') {
      i++;
    } else if (c === '\\' && process.platform !== 'win32') {
      word = (word || '') + (command[++i] || '');
    } else if (/\s/.test(c) && c !== '\n') {
      push();
    } else if (/[;&|\n]/.test(c)) {
      push();
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') i++;
      out.push({ op: two === '&&' || two === '||' ? two : c });
    } else {
      word = (word || '') + c;
    }
  }
  push();
  return out;
}

const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^\$(HOME|\{HOME\})(?=$|[\\/])/, os.homedir());

/**
 * The color-focus commands in a shell command line, each with its arguments and the folder it runs in
 * (following a leading `cd dir &&`). E.g. `cd proj && ~/.color-focus/bin/color-focus start "Exercise 1"`.
 */
function colorFocusCalls(command, cwd) {
  const calls = [];
  let words = [];
  let dir = cwd;
  const flush = () => {
    const w = words;
    words = [];
    if (!w.length) return;
    if (w[0] === 'cd' && w.length <= 2) {
      dir = path.resolve(dir, expandHome(w[1] || os.homedir()));
      return;
    }
    const at = w.findIndex((x) => /(^|[\\/])color-focus(\.cmd|\.js)?$/i.test(x));
    if (at >= 0) calls.push({ args: w.slice(at + 1).map(expandHome), cwd: dir });
  };
  for (const t of shellWords(String(command || ''))) {
    if (typeof t === 'string') words.push(t);
    else flush();
  }
  flush();
  return calls;
}

module.exports = {
  D, HOME, ACTIVE, INBOX, BEFORE, readActive, inside, sendBlocks,
  markHandled, takeHandled, shellWords, colorFocusCalls,
};
