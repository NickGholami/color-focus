#!/usr/bin/env node
// color-focus: tell the Color Focus VS Code extension what to highlight.
//
//   color-focus start "Exercise 1" [--color "#6bcb77"]   code the AI agent writes from now on gets this label
//   color-focus stop                                      stop labeling
//   color-focus status                                    show the active label
//   color-focus add <file> <from>[-<to>] --label "Exercise 1" [--color ...]
//                                                         highlight lines by hand (1-based, inclusive)

const fs = require('fs');
const path = require('path');
const { ACTIVE, HOME, readActive, sendBlocks, takeHandled } = require('./common');

const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v !== undefined ? v : argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

/** Run one command. Returns { code, out }; throws if a file can't be written (e.g. inside a sandbox). */
function run(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parse(rest);
  const ok = (out) => ({ code: 0, out });
  const fail = (out) => ({ code: 1, out });

  if (cmd === 'start') {
    const label = pos.join(' ').trim();
    if (!label) return fail('Usage: color-focus start "Exercise 1"');
    fs.mkdirSync(HOME, { recursive: true });
    const active = { label, dir: path.resolve(cwd, opts.dir || '.'), started: Date.now() };
    if (opts.color) active.color = opts.color;
    fs.writeFileSync(ACTIVE, JSON.stringify(active, null, 2));
    return ok(`Color Focus: code changed under ${active.dir} is now highlighted as "${label}". Run "color-focus stop" when done.`);
  }
  if (cmd === 'stop') {
    const a = readActive();
    try { fs.unlinkSync(ACTIVE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return ok(a ? `Color Focus: stopped highlighting "${a.label}".` : 'Color Focus: no label was active.');
  }
  if (cmd === 'status') {
    const a = readActive();
    return ok(a ? `Color Focus: highlighting "${a.label}" under ${a.dir} (since ${new Date(a.started).toLocaleTimeString()}).` : 'Color Focus: no label active.');
  }
  if (cmd === 'add') {
    const [file, span] = pos;
    const m = /^(\d+)(?:-(\d+))?$/.exec(span || '');
    if (!file || !m) return fail('Usage: color-focus add <file> <from>[-<to>] --label "Exercise 1"');
    const abs = path.resolve(cwd, file);
    const text = fs.readFileSync(abs, 'utf8');
    const from = Number(m[1]) - 1;
    const to = Number(m[2] || m[1]) - 1;
    const label = opts.label || (readActive() || {}).label;
    if (!label) return fail('Give a label: color-focus add <file> <from>[-<to>] --label "Exercise 1"');
    sendBlocks(abs, text, [{ start: Math.min(from, to), end: Math.max(from, to) }], [label], opts.color);
    return ok(`Color Focus: highlighted ${path.basename(abs)} lines ${from + 1}-${to + 1} as "${label}".`);
  }
  return { code: cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0, out: USAGE };
}

function main() {
  const argv = process.argv.slice(2);
  // Already done by the Codex hook just before this command ran (see common.js): just report it.
  const done = takeHandled(argv);
  if (done) return console.log(done);
  let result;
  try {
    result = run(argv);
  } catch (e) {
    if (['EPERM', 'EACCES', 'EROFS'].includes(e.code)) {
      console.error(
        `Color Focus: could not write to ${HOME} (${e.code}). A sandbox may be blocking it. ` +
          'Run this command with permission to write outside the project, or set up the Codex integration ' +
          'in VS Code (Color Focus: Set Up Codex Integration…) so its hook does this for you.'
      );
      process.exit(1);
    }
    throw e;
  }
  (result.code ? console.error : console.log)(result.out);
  process.exitCode = result.code;
}

module.exports = { run };

if (require.main === module) main();
