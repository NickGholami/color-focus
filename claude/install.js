#!/usr/bin/env node
// Installs (or removes) the AI agent integration, for Claude Code and/or Codex:
//  - scripts in ~/.color-focus/bin (hook, color-focus command), shared by both
//  - Claude Code: a Pre/PostToolUse hook in ~/.claude/settings.json and a skill in ~/.claude/skills/color-focus
//  - Codex:       a Pre/PostToolUse hook in ~/.codex/hooks.json   and a skill in ~/.agents/skills/color-focus
// The skill tells the agent when to start/stop a label; the hook highlights what it changes.
// Used by the "Color Focus: Set Up … Integration" commands; can also run directly:
//   node claude/install.js [install|uninstall|status] [claude|codex]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const HOME = process.env.COLOR_FOCUS_HOME || path.join(os.homedir(), '.color-focus');
const BIN = path.join(HOME, 'bin');
const HOOK = path.join(BIN, 'hook.js');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CODEX = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AGENTS_SKILLS = process.env.COLOR_FOCUS_AGENTS_SKILLS || path.join(os.homedir(), '.agents', 'skills');

const AGENTS = {
  claude: {
    name: 'Claude Code',
    config: path.join(CLAUDE, 'settings.json'),
    skillDir: path.join(CLAUDE, 'skills', 'color-focus'),
    matchers: { PreToolUse: 'Edit|Write|MultiEdit', PostToolUse: 'Edit|Write|MultiEdit' },
  },
  codex: {
    name: 'Codex',
    config: path.join(CODEX, 'hooks.json'),
    skillDir: path.join(AGENTS_SKILLS, 'color-focus'),
    // apply_patch: file edits. Bash: `color-focus start/stop/add`, which Codex's sandbox would block.
    matchers: { PreToolUse: '^(apply_patch|Bash)$', PostToolUse: '^(apply_patch|Bash)$' },
  },
};
const EVENTS = ['PreToolUse', 'PostToolUse'];

/** This extension's version. Installed scripts remember it, so an older copy never overwrites newer ones. */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
const versionParts = (v) => String(v || '0').trim().split('.').map((n) => parseInt(n, 10) || 0);
function isOlder(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
const ours = (command) => String(command || '').includes('.color-focus') || String(command || '').includes(HOOK);

function agentOf(id) {
  const a = AGENTS[id];
  if (!a) throw new Error(`Unknown agent "${id}". Use one of: ${Object.keys(AGENTS).join(', ')}.`);
  return a;
}

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

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: then we change nothing
}

function withoutOurHooks(settings) {
  const hooks = settings.hooks || {};
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !ours(h.command)) }))
      .filter((entry) => entry.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (settings.hooks && !Object.keys(hooks).length) delete settings.hooks;
  return settings;
}

function writeConfig(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.before-color-focus');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
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
  put('VERSION', VERSION + '\n');
  if (node) {
    put('color-focus', `#!/bin/sh\nexec "${node}" "$(dirname "$0")/color-focus.js" "$@"\n`, 0o755);
    put('color-focus.cmd', `@"${node}" "%~dp0color-focus.js" %*\r\n`);
  }
  return changed;
}

function install(agentId = 'claude', { node = findNode() } = {}) {
  const agent = agentOf(agentId);
  if (!node) throw new Error('Node.js was not found. Install it from https://nodejs.org and try again.');
  const settings = withoutOurHooks(readConfig(agent.config));
  copyScripts(node);

  const command = `"${node}" "${HOOK}"`;
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ matcher: agent.matchers[event], hooks: [{ type: 'command', command, timeout: 10 }] });
  }
  writeConfig(agent.config, settings);

  fs.mkdirSync(agent.skillDir, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'SKILL.md'), path.join(agent.skillDir, 'SKILL.md'));
  return { agent: agent.name, node, config: agent.config, skill: agent.skillDir, bin: BIN };
}

function uninstall(agentId = 'claude') {
  const agent = agentOf(agentId);
  if (fs.existsSync(agent.config)) writeConfig(agent.config, withoutOurHooks(readConfig(agent.config)));
  fs.rmSync(agent.skillDir, { recursive: true, force: true });
  if (Object.keys(AGENTS).some(isInstalled)) return; // the other agent still uses the scripts
  fs.rmSync(BIN, { recursive: true, force: true });
  for (const f of ['active.json', 'before', 'handled']) fs.rmSync(path.join(HOME, f), { recursive: true, force: true });
}

function isInstalled(agentId = 'claude') {
  try {
    const hooks = readConfig(agentOf(agentId).config).hooks || {};
    const any = Object.values(hooks).flat().some((e) => (e.hooks || []).some((h) => ours(h.command)));
    return any && fs.existsSync(HOOK);
  } catch {
    return false;
  }
}

/** After an extension update: bring installed scripts and skills up to date (keeps the same node). */
function refresh() {
  const installed = Object.keys(AGENTS).filter(isInstalled);
  if (!installed.length) return false;
  // Another VS Code window may still run an older version of the extension: leave newer scripts alone.
  let theirs = '0.0.0';
  try { theirs = fs.readFileSync(path.join(BIN, 'VERSION'), 'utf8'); } catch {}
  if (isOlder(VERSION, theirs)) return false;
  let node = null;
  try { node = /exec "([^"]+)"/.exec(fs.readFileSync(path.join(BIN, 'color-focus'), 'utf8'))[1]; } catch {}
  const changed = copyScripts(node);
  for (const id of installed) {
    const dir = AGENTS[id].skillDir;
    if (fs.existsSync(dir)) fs.copyFileSync(path.join(HERE, 'SKILL.md'), path.join(dir, 'SKILL.md'));
  }
  return changed;
}

module.exports = { AGENTS, install, uninstall, isInstalled, refresh, findNode, isOlder, BIN, VERSION };

if (require.main === module) {
  const [cmd = 'install', agentId = 'claude'] = process.argv.slice(2);
  if (cmd === 'install') console.log('Installed:', install(agentId));
  else if (cmd === 'uninstall') { uninstall(agentId); console.log('Removed.'); }
  else console.log(`${agentOf(agentId).name}: ${isInstalled(agentId) ? 'installed' : 'not installed'}.`);
}
