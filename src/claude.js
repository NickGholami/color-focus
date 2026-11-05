// "Color Focus: Set Up Claude Code Integration" and "Set Up Codex Integration"
// (see claude/install.js for what they install).

const vscode = require('vscode');
const installer = require('../claude/install');

const RESTART = {
  claude: 'Restart Claude Code',
  codex:
    'Restart Codex and click "Allow all" when it shows "Review hooks" (or allow them in Codex\'s settings). ' +
    'Codex skips hooks until you allow them',
};

async function setUp(_ctx, agentId = 'claude') {
  const agent = installer.AGENTS[agentId];
  const installed = installer.isInstalled(agentId);
  const detail =
    `While you tell ${agent.name} to work on a named exercise (e.g. "solve exercise 1"), every block of code it writes ` +
    'or changes is highlighted here with that label.\n\n' +
    `This adds a hook to ${agent.config}, a skill in ${agent.skillDir} and small scripts in ${installer.BIN}. ` +
    `The hook file is backed up first. ${RESTART[agentId]} afterwards.`;
  const choice = installed
    ? await vscode.window.showInformationMessage(`${agent.name} integration is set up.`, { modal: true, detail }, 'Reinstall', 'Remove')
    : await vscode.window.showInformationMessage(`Set up ${agent.name} integration?`, { modal: true, detail }, 'Set Up');
  if (!choice) return;
  try {
    if (choice === 'Remove') {
      installer.uninstall(agentId);
      vscode.window.showInformationMessage(`Color Focus: ${agent.name} integration removed. Restart ${agent.name}.`);
      return;
    }
    installer.install(agentId);
    vscode.window.showInformationMessage(
      `Color Focus: ${agent.name} integration is set up. ${RESTART[agentId]}, then ask it e.g. "solve exercise 1"; ` +
        'the code it writes gets highlighted as "Exercise 1".'
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Color Focus: could not set up ${agent.name} integration: ${e.message}`);
  }
}

/** Keep the installed scripts in step with this version of the extension. */
function refreshInstalledScripts() {
  try {
    installer.refresh();
  } catch {}
}

module.exports = { setUp, refreshInstalledScripts };
