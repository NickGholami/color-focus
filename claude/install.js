#!/usr/bin/env node
// Installs (or removes) the Claude Code integration:
//  - scripts in ~/.color-focus/bin (hook, color-focus command)
//  - a Pre/PostToolUse hook in ~/.claude/settings.json
//  - a skill in ~/.claude/skills/color-focus that tells Claude when to start/stop a label
// Used by the "Color Focus: Set Up Claude Code Integration" command; can also run directly:
//   node claude/install.js [install|uninstall|status]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const HOME = process.env.COLOR_FOCUS_HOME || path.join(os.homedir(), '.color-focus');
const BIN = path.join(HOME, 'bin');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const SKILL_DIR = path.join(CLAUDE, 'skills', 'color-focus');
const MATCHER = 'Edit|Write|MultiEdit';
const HOOK = path.join(BIN, 'hook.js');
const ours = (command) => String(command || '').includes('.color-focus') || String(command || '').includes(HOOK);

function linediffPath() {
  const nextTo = path.join(HERE, 'linediff.js');
  return fs.existsSync(nextTo) ? nextTo : path.join(HERE, '..', 'src', 'linediff.js');
}

/** Absolute path to node. Not VS Code's own binary: that one moves when VS Code updates. */
function findNode() {
  if (!process.versions.electron) return process.execPath;
  try {
    if (process.platform === 'win32') return execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const shell = process.env.SHELL || '/bin/sh';
    const out = execFileSync(shell, ['-lic', 'command -v node'], { encoding: 'utf8', timeout: 10000 });
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
    if (line) return line;
  } catch {}
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) if (fs.existsSync(p)) return p;
  return null;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: then we change nothing
}

function withoutOurHooks(settings) {
  const hooks = settings.hooks || {};
  for (const event of ['PreToolUse', 'PostToolUse']) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !ours(h.command)) }))
      .filter((entry) => entry.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (settings.hooks && !Object.keys(hooks).length) delete settings.hooks;
  return settings;
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE, { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.before-color-focus');
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

/** Copy the scripts into ~/.color-focus/bin. Returns true if anything changed. */
function copyScripts(node) {
  fs.mkdirSync(BIN, { recursive: true });
  let changed = false;
  const put = (name, content, mode) => {
    const dest = path.join(BIN, name);
    let old = null;
    try { old = fs.readFileSync(dest, 'utf8'); } catch {}
    if (old !== content) {
      fs.writeFileSync(dest, content);
      changed = true;
    }
    if (mode) fs.chmodSync(dest, mode);
  };
  for (const f of ['common.js', 'hook.js', 'color-focus.js']) put(f, fs.readFileSync(path.join(HERE, f), 'utf8'));
  put('linediff.js', fs.readFileSync(linediffPath(), 'utf8'));
  if (node) {
    put('color-focus', `#!/bin/sh\nexec "${node}" "$(dirname "$0")/color-focus.js" "$@"\n`, 0o755);
    put('color-focus.cmd', `@"${node}" "%~dp0color-focus.js" %*\r\n`);
  }
  return changed;
}

function install({ node = findNode() } = {}) {
  if (!node) throw new Error('Node.js was not found. Install it from https://nodejs.org and try again.');
  const settings = withoutOurHooks(readSettings());
  copyScripts(node);

  const command = `"${node}" "${HOOK}"`;
  settings.hooks = settings.hooks || {};
  for (const event of ['PreToolUse', 'PostToolUse']) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ matcher: MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] });
  }
  writeSettings(settings);

  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'SKILL.md'), path.join(SKILL_DIR, 'SKILL.md'));
  return { node, settings: SETTINGS, skill: SKILL_DIR, bin: BIN };
}

function uninstall() {
  if (fs.existsSync(SETTINGS)) writeSettings(withoutOurHooks(readSettings()));
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
  fs.rmSync(path.join(HOME, 'active.json'), { force: true });
  fs.rmSync(path.join(HOME, 'before'), { recursive: true, force: true });
}

function isInstalled() {
  try {
    const hooks = readSettings().hooks || {};
    const any = Object.values(hooks).flat().some((e) => (e.hooks || []).some((h) => ours(h.command)));
    return any && fs.existsSync(HOOK);
  } catch {
    return false;
  }
}

/** After an extension update: bring installed scripts and skill up to date (keeps the same node). */
function refresh() {
  if (!isInstalled()) return false;
  let node = null;
  try { node = /exec "([^"]+)"/.exec(fs.readFileSync(path.join(BIN, 'color-focus'), 'utf8'))[1]; } catch {}
  const changed = copyScripts(node);
  if (fs.existsSync(SKILL_DIR)) fs.copyFileSync(path.join(HERE, 'SKILL.md'), path.join(SKILL_DIR, 'SKILL.md'));
  return changed;
}

module.exports = { install, uninstall, isInstalled, refresh, findNode, SETTINGS, SKILL_DIR, BIN };

if (require.main === module) {
  const cmd = process.argv[2] || 'install';
  if (cmd === 'install') console.log('Installed:', install());
  else if (cmd === 'uninstall') { uninstall(); console.log('Removed.'); }
  else console.log(isInstalled() ? 'Installed.' : 'Not installed.');
}
