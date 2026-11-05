#!/usr/bin/env node
// color-focus: tell the Color Focus VS Code extension what to highlight.
//
//   color-focus start "Exercise 1" [--color "#6bcb77"]   code Claude writes from now on gets this label
//   color-focus stop                                      stop labeling
//   color-focus status                                    show the active label
//   color-focus add <file> <from>[-<to>] --label "Exercise 1" [--color ...]
//                                                         highlight lines by hand (1-based, inclusive)

const fs = require('fs');
const path = require('path');
const { ACTIVE, HOME, readActive, sendBlocks } = require('./common');

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

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parse(rest);

  if (cmd === 'start') {
    const label = pos.join(' ').trim();
    if (!label) fail('Usage: color-focus start "Exercise 1"');
    fs.mkdirSync(HOME, { recursive: true });
    const active = { label, dir: path.resolve(opts.dir || process.cwd()), started: Date.now() };
    if (opts.color) active.color = opts.color;
    fs.writeFileSync(ACTIVE, JSON.stringify(active, null, 2));
    console.log(`Color Focus: code changed under ${active.dir} is now highlighted as "${label}". Run "color-focus stop" when done.`);
  } else if (cmd === 'stop') {
    const a = readActive();
    try { fs.unlinkSync(ACTIVE); } catch {}
    console.log(a ? `Color Focus: stopped highlighting "${a.label}".` : 'Color Focus: no label was active.');
  } else if (cmd === 'status') {
    const a = readActive();
    console.log(a ? `Color Focus: highlighting "${a.label}" under ${a.dir} (since ${new Date(a.started).toLocaleTimeString()}).` : 'Color Focus: no label active.');
  } else if (cmd === 'add') {
    const [file, span] = pos;
    const m = /^(\d+)(?:-(\d+))?$/.exec(span || '');
    if (!file || !m) fail('Usage: color-focus add <file> <from>[-<to>] --label "Exercise 1"');
    const abs = path.resolve(file);
    const text = fs.readFileSync(abs, 'utf8');
    const from = Number(m[1]) - 1;
    const to = Number(m[2] || m[1]) - 1;
    const label = opts.label || (readActive() || {}).label;
    const labels = label ? [label] : [];
    sendBlocks(abs, text, [{ start: Math.min(from, to), end: Math.max(from, to) }], labels, opts.color);
    console.log(`Color Focus: highlighted ${path.basename(abs)} lines ${from + 1}-${to + 1}${label ? ` as "${label}"` : ''}.`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1);
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main();
