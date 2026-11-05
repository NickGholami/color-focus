// "Color Focus: Set Up Claude Code Integration" (see claude/install.js for what it installs).

const vscode = require('vscode');
const installer = require('../claude/install');

async function setUp() {
  const installed = installer.isInstalled();
  const detail =
    'While you tell Claude Code to work on a named exercise (e.g. "solve exercise 1"), every block of code it writes ' +
    'or changes is highlighted here with that label.\n\n' +
    `This adds a hook to ${installer.SETTINGS}, a skill in ${installer.SKILL_DIR} and small scripts in ${installer.BIN}. ` +
    'Your settings file is backed up first. Restart Claude Code afterwards.';
  const choice = installed
    ? await vscode.window.showInformationMessage('Claude Code integration is set up.', { modal: true, detail }, 'Reinstall', 'Remove')
    : await vscode.window.showInformationMessage('Set up Claude Code integration?', { modal: true, detail }, 'Set Up');
  if (!choice) return;
  try {
    if (choice === 'Remove') {
      installer.uninstall();
      vscode.window.showInformationMessage('Color Focus: Claude Code integration removed. Restart Claude Code.');
      return;
    }
    installer.install();
    vscode.window.showInformationMessage(
      'Color Focus: Claude Code integration is set up. Restart Claude Code, then ask it e.g. "solve exercise 1"; the code it writes gets highlighted as "Exercise 1".'
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Color Focus: could not set up Claude Code integration: ${e.message}`);
  }
}

/** Keep the installed scripts in step with this version of the extension. */
function refreshInstalledScripts() {
  try {
    installer.refresh();
  } catch {}
}

module.exports = { setUp, refreshInstalledScripts };
