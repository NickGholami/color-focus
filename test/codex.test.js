// The Codex side: apply_patch edits, color-focus commands carried out by the hook (Codex's sandbox
// blocks them), and the installer. Payloads are shaped like Codex's own (codex-rs/core/src/tools/handlers):
//   apply_patch: { tool_name: "apply_patch", tool_input: { command: "<patch text>" } }
//   shell:       { tool_name: "Bash",        tool_input: { command: "<command line>" } }
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-codex-'));
const env = {
  ...process.env,
  COLOR_FOCUS_HOME: path.join(tmp, 'home'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  CODEX_HOME: path.join(tmp, 'codex'),
  COLOR_FOCUS_AGENTS_SKILLS: path.join(tmp, 'agents', 'skills'),
};
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
const dir = path.join(__dirname, '..', 'claude');
const { patchFiles } = require('../claude/hook');
const { colorFocusCalls } = require('../claude/common');

const cli = (args, cwd = proj) => spawnSync(process.execPath, [path.join(dir, 'color-focus.js'), ...args], { env, cwd, encoding: 'utf8' });
const hook = (payload) => execFileSync(process.execPath, [path.join(dir, 'hook.js')], { env, input: JSON.stringify(payload), encoding: 'utf8' });
const base = (event) => ({ session_id: 'c1', turn_id: 't1', cwd: proj, hook_event_name: event, model: 'gpt', permission_mode: 'default', transcript_path: null, tool_use_id: 'u1' });
const shell = (command, cwd = proj) => hook({ ...base('PreToolUse'), cwd, tool_name: 'Bash', tool_input: { command } });
const inbox = () => {
  const d = path.join(env.COLOR_FOCUS_HOME, 'inbox');
  if (!fs.existsSync(d)) return [];
  const reqs = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')));
  fs.rmSync(d, { recursive: true });
  return reqs;
};
/** Do what Codex does: Pre hook, apply the change, Post hook. */
function codexPatches(patch, apply) {
  hook({ ...base('PreToolUse'), tool_name: 'apply_patch', tool_input: { command: patch } });
  apply();
  hook({ ...base('PostToolUse'), tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success.' });
}
/** Make ~/.color-focus read-only, like inside Codex's sandbox. */
function sandboxed(fn) {
  const all = [env.COLOR_FOCUS_HOME, ...fs.readdirSync(env.COLOR_FOCUS_HOME).map((n) => path.join(env.COLOR_FOCUS_HOME, n))]
    .filter((p) => fs.statSync(p).isDirectory());
  for (const p of all) fs.chmodSync(p, 0o555);
  try {
    return fn();
  } finally {
    for (const p of all) fs.chmodSync(p, 0o755);
  }
}
const active = () => { try { return JSON.parse(fs.readFileSync(path.join(env.COLOR_FOCUS_HOME, 'active.json'), 'utf8')); } catch { return null; } };

test('finds the files a patch adds, changes and moves', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: new.py',
    '+print(1)',
    '*** Update File: src/a.py',
    '@@ def a():',
    '-    return 1',
    '+    return 2',
    '*** Update File: old.py',
    '*** Move to: moved.py',
    '@@',
    '-x',
    '+y',
    '*** Delete File: gone.py',
    '*** End Patch',
  ].join('\n');
  assert.deepStrictEqual(patchFiles(patch), [
    { from: 'new.py', to: 'new.py', added: true },
    { from: 'src/a.py', to: 'src/a.py', added: false },
    { from: 'old.py', to: 'moved.py', added: false },
  ]);
});

test('finds color-focus commands in a shell command line', () => {
  const home = os.homedir();
  assert.deepStrictEqual(colorFocusCalls('~/.color-focus/bin/color-focus start "Exercise 1"', '/p'), [
    { args: ['start', 'Exercise 1'], cwd: '/p' },
  ]);
  assert.deepStrictEqual(colorFocusCalls("cd sub && $HOME/.color-focus/bin/color-focus start 'Opgave 3b' --color \"#ff0000\"; echo hi", '/p'), [
    { args: ['start', 'Opgave 3b', '--color', '#ff0000'], cwd: '/p/sub' },
  ]);
  assert.deepStrictEqual(colorFocusCalls('node ~/.color-focus/bin/color-focus.js add ~/x.py 3-4 --label "Ex 2"', '/p'), [
    { args: ['add', path.join(home, 'x.py'), '3-4', '--label', 'Ex 2'], cwd: '/p' },
  ]);
  assert.deepStrictEqual(colorFocusCalls('ls -la && git status', '/p'), []);
});

test('without a label, Codex edits are ignored', () => {
  const f = path.join(proj, 'a.py');
  fs.writeFileSync(f, 'x = 1\n');
  codexPatches('*** Begin Patch\n*** Update File: a.py\n@@\n x = 1\n+y = 2\n*** End Patch', () => fs.writeFileSync(f, 'x = 1\ny = 2\n'));
  assert.deepStrictEqual(inbox(), []);
});

test('the hook starts the label before the shell command runs, so the sandbox cannot block it', () => {
  fs.mkdirSync(env.COLOR_FOCUS_HOME, { recursive: true });
  shell('cd sub && ~/.color-focus/bin/color-focus start "Exercise 1"');
  assert.strictEqual(active().label, 'Exercise 1');
  assert.strictEqual(active().dir, path.join(proj, 'sub'));

  // The command itself then runs inside the sandbox: it can't write, but reports what the hook did.
  const r = sandboxed(() => cli(['start', 'Exercise 1'], path.join(proj, 'sub')));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /highlighted as "Exercise 1"/);

  shell('~/.color-focus/bin/color-focus start "Exercise 2"');
  assert.strictEqual(active().label, 'Exercise 2');
  assert.strictEqual(active().dir, proj);
  const r2 = cli(['start', 'Exercise 2']); // not sandboxed: still only reports, doesn't start twice
  assert.match(r2.stdout, /"Exercise 2"/);
});

test('apply_patch: changed, added and moved files are highlighted with the label', () => {
  const a = path.join(proj, 'a.py');
  const old = path.join(proj, 'old.py');
  fs.writeFileSync(a, 'def a():\n    return 1\n\n\ndef b():\n    return 2\n');
  fs.writeFileSync(old, 'one\ntwo\n');
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.py',
    '@@ def b():',
    '-    return 2',
    '+    print("hi")',
    '+    return 20',
    '*** Add File: sub/new.py',
    '+def d():',
    '+    return 4',
    `*** Update File: ${old}`, // absolute paths work too
    '*** Move to: moved.py',
    '@@',
    ' one',
    '+one and a half',
    ' two',
    '*** End Patch',
  ].join('\n');
  codexPatches(patch, () => {
    fs.writeFileSync(a, 'def a():\n    return 1\n\n\ndef b():\n    print("hi")\n    return 20\n');
    fs.writeFileSync(path.join(proj, 'sub/new.py'), 'def d():\n    return 4\n');
    fs.renameSync(old, path.join(proj, 'moved.py'));
    fs.writeFileSync(path.join(proj, 'moved.py'), 'one\none and a half\ntwo\n');
  });
  const reqs = inbox();
  const by = Object.fromEntries(reqs.map((r) => [path.basename(r.file), r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a.py', 'moved.py', 'new.py']);
  assert.deepStrictEqual(by['a.py'].blocks, [{ line: 5, text: '    print("hi")\n    return 20' }]);
  assert.deepStrictEqual(by['new.py'].blocks, [{ line: 0, text: 'def d():\n    return 4' }]);
  assert.deepStrictEqual(by['moved.py'].blocks, [{ line: 1, text: 'one and a half' }]);
  for (const r of reqs) assert.deepStrictEqual(r.labels, ['Exercise 2']);
});

test('add and stop also work through the hook; without the hook a sandboxed command explains what to do', () => {
  shell('~/.color-focus/bin/color-focus add a.py 1-2 --label "Exercise 2"');
  assert.deepStrictEqual(inbox()[0].blocks, [{ line: 0, text: 'def a():\n    return 1' }]);
  assert.match(sandboxed(() => cli(['add', 'a.py', '1-2', '--label', 'Exercise 2'])).stdout, /lines 1-2/);

  shell('~/.color-focus/bin/color-focus stop');
  assert.strictEqual(active(), null);
  assert.match(sandboxed(() => cli(['stop'])).stdout, /stopped highlighting "Exercise 2"/);

  const blocked = sandboxed(() => cli(['start', 'Exercise 9']));
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /could not write .*Set Up Codex Integration/s);
  assert.strictEqual(active(), null);
});

test('installer: Codex hooks + skill, alongside Claude Code; removing one keeps the other working', () => {
  const hooksFile = path.join(env.CODEX_HOME, 'hooks.json');
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  fs.writeFileSync(hooksFile, JSON.stringify(mine));
  const run = (...args) => execFileSync(process.execPath, [path.join(dir, 'install.js'), ...args], { env, encoding: 'utf8' });

  run('install', 'codex');
  run('install', 'codex'); // twice: no duplicates
  run('install', 'claude');
  const h = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.deepStrictEqual(h.hooks.Stop, mine.hooks.Stop);
  assert.deepStrictEqual(h.hooks.PreToolUse.map((e) => e.matcher), ['^(apply_patch|Bash)$']);
  assert.deepStrictEqual(h.hooks.PostToolUse.map((e) => e.matcher), ['^(apply_patch|Bash)$']);
  assert.ok(h.hooks.PreToolUse[0].hooks[0].command.endsWith(`${path.join(env.COLOR_FOCUS_HOME, 'bin', 'hook.js')}"`));
  assert.ok(fs.existsSync(path.join(env.COLOR_FOCUS_AGENTS_SKILLS, 'color-focus/SKILL.md')));
  assert.match(run('status', 'codex'), /Codex: installed/);

  // The installed hook works on a Codex payload
  const hookCmd = path.join(env.COLOR_FOCUS_HOME, 'bin', 'hook.js');
  execFileSync(process.execPath, [hookCmd], { env, input: JSON.stringify({ ...base('PreToolUse'), tool_name: 'Bash', tool_input: { command: '~/.color-focus/bin/color-focus start "Task 5"' } }) });
  assert.strictEqual(active().label, 'Task 5');

  // An older copy of the extension (e.g. in another VS Code window) leaves newer scripts alone.
  const refresh = () => execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(dir, 'install.js'))}).refresh())`], { env, encoding: 'utf8' }).trim();
  const versionFile = path.join(env.COLOR_FOCUS_HOME, 'bin', 'VERSION');
  assert.strictEqual(fs.readFileSync(versionFile, 'utf8').trim(), require('../package.json').version);
  fs.writeFileSync(versionFile, '99.0.0\n');
  fs.appendFileSync(hookCmd, '// newer\n');
  assert.strictEqual(refresh(), 'false');
  assert.match(fs.readFileSync(hookCmd, 'utf8'), /\/\/ newer/);
  fs.writeFileSync(versionFile, '0.9.0\n'); // installed by an older version: brought up to date
  assert.strictEqual(refresh(), 'true');
  assert.doesNotMatch(fs.readFileSync(hookCmd, 'utf8'), /\/\/ newer/);
  const { isOlder } = require('../claude/install');
  assert.ok(isOlder('1.1.0', '1.2.0') && isOlder('1.9.0', '1.10.0') && !isOlder('1.1.0', '1.1.0') && !isOlder('2.0.0', '1.9.9'));

  run('uninstall', 'codex');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hooksFile, 'utf8')), mine);
  assert.ok(!fs.existsSync(path.join(env.COLOR_FOCUS_AGENTS_SKILLS, 'color-focus')));
  assert.ok(fs.existsSync(hookCmd), 'Claude Code still uses the scripts');
  assert.match(run('status', 'claude'), /Claude Code: installed/);

  run('uninstall', 'claude');
  assert.ok(!fs.existsSync(path.join(env.COLOR_FOCUS_HOME, 'bin')));
  assert.strictEqual(active(), null);
});
