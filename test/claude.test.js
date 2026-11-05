// The Claude Code hook, the color-focus command and the installer, run against temp folders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-claude-'));
const env = { ...process.env, COLOR_FOCUS_HOME: path.join(tmp, 'home'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj);
const dir = path.join(__dirname, '..', 'claude');

const cli = (...args) => execFileSync(process.execPath, [path.join(dir, 'color-focus.js'), ...args], { env, cwd: proj, encoding: 'utf8' });
const hook = (payload) => execFileSync(process.execPath, [path.join(dir, 'hook.js')], { env, input: JSON.stringify(payload), encoding: 'utf8' });
const inbox = () => {
  const d = path.join(env.COLOR_FOCUS_HOME, 'inbox');
  if (!fs.existsSync(d)) return [];
  const reqs = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')));
  fs.rmSync(d, { recursive: true });
  return reqs;
};
/** Do what Claude does: Pre hook, change the file, Post hook. */
function claudeEdits(file, newText, tool = 'Edit', extra = {}) {
  const base = { session_id: 's1', cwd: proj, tool_name: tool, tool_input: { file_path: file, ...extra } };
  hook({ ...base, hook_event_name: 'PreToolUse' });
  fs.writeFileSync(file, newText);
  hook({ ...base, hook_event_name: 'PostToolUse', tool_response: {} });
}

test('without an active label, the hook does nothing', () => {
  const f = path.join(proj, 'a.py');
  fs.writeFileSync(f, 'x = 1\n');
  claudeEdits(f, 'x = 1\ny = 2\n');
  assert.deepStrictEqual(inbox(), []);
});

test('with a label, changed blocks are sent with their text', () => {
  assert.match(cli('start', 'Exercise 1'), /Exercise 1/);
  const f = path.join(proj, 'a.py');
  fs.writeFileSync(f, 'def a():\n    return 1\n\n\ndef b():\n    return 2\n');
  claudeEdits(f, 'def a():\n    return 1\n\n\ndef b():\n    print("hi")\n    return 20\n');
  const [req] = inbox();
  assert.strictEqual(req.file, f);
  assert.deepStrictEqual(req.labels, ['Exercise 1']);
  assert.deepStrictEqual(req.blocks, [{ line: 5, text: '    print("hi")\n    return 20' }]);
});

test('a new file is highlighted whole', () => {
  const f = path.join(proj, 'new.py');
  claudeEdits(f, 'def d():\n    return 4\n', 'Write', { content: 'def d():\n    return 4\n' });
  const [req] = inbox();
  assert.deepStrictEqual(req.blocks, [{ line: 0, text: 'def d():\n    return 4' }]);
});

test('files outside the folder where the label was started are ignored', () => {
  const f = path.join(tmp, 'outside.py');
  fs.writeFileSync(f, 'a\n');
  claudeEdits(f, 'a\nb\n');
  assert.deepStrictEqual(inbox(), []);
});

test('without the Pre hook copy, the hook finds the new text instead', () => {
  const f = path.join(proj, 'c.py');
  fs.writeFileSync(f, 'one\ntwo = 2\nthree\n');
  hook({ session_id: 's2', cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: f, old_string: 'two', new_string: 'two = 2' } });
  const [req] = inbox();
  assert.deepStrictEqual(req.blocks, [{ line: 1, text: 'two = 2' }]);
});

test('add highlights given lines; stop turns labeling off; bad input never fails the hook', () => {
  const f = path.join(proj, 'a.py');
  assert.match(cli('add', f, '1-2'), /lines 1-2 as "Exercise 1"/);
  assert.deepStrictEqual(inbox()[0].blocks, [{ line: 0, text: 'def a():\n    return 1' }]);
  assert.match(cli('stop'), /stopped/);
  assert.match(cli('status'), /no label/);
  execFileSync(process.execPath, [path.join(dir, 'hook.js')], { env, input: 'not json' });
});

test('installer adds hooks + skill, keeps other settings, and removes cleanly', () => {
  const settingsFile = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const mine = { model: 'opus', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(mine));
  const run = (cmd) => execFileSync(process.execPath, [path.join(dir, 'install.js'), cmd], { env, encoding: 'utf8' });

  run('install');
  run('install'); // twice: no duplicates
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.PostToolUse.length, 2);
  assert.strictEqual(s.hooks.PreToolUse.length, 1);
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.endsWith(`${path.join(env.COLOR_FOCUS_HOME, "bin", "hook.js")}"`));
  assert.ok(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills/color-focus/SKILL.md')));
  // The installed wrapper works on its own
  const out = execFileSync(path.join(env.COLOR_FOCUS_HOME, 'bin/color-focus'), ['status'], { env, encoding: 'utf8' });
  assert.match(out, /no label/);

  run('uninstall');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), mine);
  assert.ok(!fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills/color-focus')));
});
