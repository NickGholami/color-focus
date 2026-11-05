const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
async function press(second, hold) {
  const n = step++;
  fs.writeFileSync(path.join(process.env.CF_SYNC, `step-${n}`), `${second} ${typeof hold === 'string' ? hold : hold ? 'hold' : 'release'}`);
  while (!fs.existsSync(path.join(process.env.CF_SYNC, `done-${n}`))) await sleep(100);
  await sleep(700);
}
exports.run = async () => {
  const out = [];
  const api = await vscode.extensions.getExtension('nickspc.color-focus').activate();
  const doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'rm.txt'));
  const ed = await vscode.window.showTextDocument(doc);
  await sleep(1500);
  for (const [a, b] of [[1, 2], [5, 6]]) {
    ed.selection = new vscode.Selection(a, 0, b, 2);
    await vscode.commands.executeCommand('colorFocus.highlight', { color: '#ff5c5c', labels: [] });
    await sleep(500);
  }
  const state = (tag) => out.push(`${tag.padEnd(40)} focus=${api.testHooks.focus() ? 'on ' : 'off'} jumping=${api.testHooks.jumping() ? 'yes' : 'no '} line=${vscode.window.activeTextEditor.selection.active.line}`);
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  state('start');
  await press('down', 'plain'); state('plain Down (calibration)');
  await press('down', 'plain'); state('plain Down (calibration)');
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  const n0 = api.testHooks.highlights(doc).length;
  await press('x', false);
  out.push(`Option+Tab, X in a block: blocks ${n0} -> ${api.testHooks.highlights(doc).length}`);
  ed.selection = new vscode.Selection(1, 0, 2, 2);
  await vscode.commands.executeCommand('colorFocus.highlight', { color: '#ff5c5c', labels: [] });
  await sleep(500);
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  for (const hold of [false, true]) {
    const h = hold ? '(holding Option)' : '(Option released)';
    await press('f', hold); state(`Option+Tab, F ${h}`);
    await press('enter', 'plain'); state(`  Enter in the focus list`);
    await press('f', hold); state(`Option+Tab, F again ${h}`);
    await press('down', hold); state(`Option+Tab, Down ${h}`);
    await press('down', hold); state(`Option+Tab, Down ${h}`);
    await press('up', hold); state(`Option+Tab, Up ${h}`);
  }
  // From outside the code (file list has focus)
  await press('f', false); await press('enter', 'plain'); state('focus on again');
  await vscode.commands.executeCommand('workbench.view.explorer'); await sleep(800);
  await press('f', false); state('Option+Tab, F from the file list');
  await press('down', false); state('Option+Tab, Down from the file list');
  // --- jump mode ---
  await press('f', false); state('focus off again');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); await sleep(400);
  const e2 = vscode.window.activeTextEditor;
  e2.selection = new vscode.Selection(0, 0, 0, 0); await sleep(300);
  out.push('--- jump mode ---');
  await press('down', false); state('Option+Tab, Down');
  await press('down', 'plain'); state('  then plain Down');
  await press('down', 'plain'); state('  then plain Down');
  await press('up', 'plain'); state('  then plain Up');
  await press('left', 'plain'); state('  then Left (should stop jumping)');
  await press('down', 'plain'); state('  then plain Down (normal move)');
  await press('down', false); state('Option+Tab, Down');
  await press('escape', 'plain'); state('  then Esc (should stop jumping)');
  await press('down', 'plain'); state('  then plain Down (normal move)');
  out.push('--- Option+arrow ---');
  const before = e2.document.getText();
  e2.selection = new vscode.Selection(0, 0, 0, 0); await sleep(300);
  await press('down', 'option'); state('Option+Down, no focus mode');
  out.push(`  text changed (line moved): ${e2.document.getText() !== before}`);
  await vscode.commands.executeCommand('undo'); await sleep(300);
  await press('f', false); await press('enter', 'plain'); state('focus on');
  e2.selection = new vscode.Selection(0, 0, 0, 0); await sleep(300);
  const before2 = e2.document.getText();
  await press('down', 'option'); state('Option+Down in focus mode');
  await press('down', 'option'); state('Option+Down in focus mode');
  await press('up', 'option'); state('Option+Up in focus mode');
  await press('down', 'plain'); state('  then plain Down (still jumping)');
  out.push(`  text changed: ${e2.document.getText() !== before2}`);
  out.push('--- fold ---');
  await press('f', false); state('focus off');
  e2.selection = new vscode.Selection(5, 0, 5, 0); await sleep(300);
  const vis = () => e2.visibleRanges.map((r) => `${r.start.line}-${r.end.line}`).join(',');
  await press('c', false); out.push(`Option+Tab, C on block 5-6: visible ${vis()}`);
  await press('c', true); out.push(`Option+Tab, C again (holding Option): visible ${vis()}`);
  fs.writeFileSync(path.join(require('os').tmpdir(), 'color-focus-keys.txt'), out.join('\n') + '\n');
};
