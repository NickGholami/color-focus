const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
async function shot(name) {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(900);
  const i = n++;
  fs.writeFileSync(path.join(process.env.CF_SYNC, `shot-${i}`), name);
  while (!fs.existsSync(path.join(process.env.CF_SYNC, `done-${i}`))) await sleep(100);
}
const GREEN = '#6bcb77', BLUE = '#4d96ff', ORANGE = '#ff9f43', PURPLE = '#9b5de5';

exports.run = async () => {
  while (!fs.existsSync(path.join(process.env.CF_SYNC, 'logo-done'))) await sleep(200);
  await vscode.extensions.getExtension('NickGholami.color-focus').activate();
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const open = async (f) => {
    const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, 'week3', f)));
    await sleep(700);
    return ed;
  };
  const hl = async (ed, from, to, color, labels) => {
    ed.selection = new vscode.Selection(from - 1, 0, to - 1, ed.document.lineAt(to - 1).text.length);
    await vscode.commands.executeCommand('colorFocus.highlight', { color, labels });
    await sleep(300);
  };
  await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders').then(() => {}, () => {});

  const f90 = await open('matrix.f90');
  await hl(f90, 7, 11, GREEN, ['exercise 1']);
  await hl(f90, 13, 17, BLUE, ['exercise 2']);

  const py = await open('week3.py');
  await hl(py, 11, 15, GREEN, ['exercise 1']);
  await hl(py, 18, 22, ORANGE, ['plotting']);
  await hl(py, 25, 31, BLUE, ['exercise 2', 'check later']);
  py.selection = new vscode.Selection(36, 0, 36, 0);
  await vscode.commands.executeCommand('revealLine', { lineNumber: 0, at: 'top' });
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await shot('screenshot-highlights');

  // Focus list (not awaited: the command finishes when the list closes)
  vscode.commands.executeCommand('colorFocus.focus');
  await sleep(800);
  await shot('screenshot-focus-picker');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await sleep(300);

  // Focus mode on one label
  await api_setFocusLabel('exercise 2');
  await sleep(300);
  await shot('screenshot-focus');
  await vscode.commands.executeCommand('colorFocus.exitFocus');

  // Label checklist on the exercise 2 block
  py.selection = new vscode.Selection(26, 4, 26, 4);
  vscode.commands.executeCommand('colorFocus.setLabel');
  await sleep(800);
  await shot('screenshot-labels');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await sleep(300);

  // Color list for a new selection
  py.selection = new vscode.Selection(32, 0, 37, 0);
  vscode.commands.executeCommand('colorFocus.highlight');
  await sleep(800);
  await shot('screenshot-colors');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await sleep(300);

  // Blocks-only view across files
  await vscode.commands.executeCommand('colorFocus.showBlocks', { scope: 'workspace', label: 'exercise 1' });
  await sleep(800);
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await shot('screenshot-blocks');

  async function api_setFocusLabel(label) {
    // Same as picking the label in the focus list.
    const ext = vscode.extensions.getExtension('NickGholami.color-focus').exports;
    ext.testHooks.setFocus({ kind: 'label', value: label });
  }
};
