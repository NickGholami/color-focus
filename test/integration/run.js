// Runs the extension inside a real VS Code window with a throwaway profile.
// Usage: VSCODE_PATH=/path/to/Electron node test/integration/run.js
const { runTests } = require('@vscode/test-electron');
const path = require('path'), os = require('os'), fs = require('fs');
const root = path.resolve(__dirname, '../..');
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-ws-'));
  fs.cpSync(path.join(root, 'test/fixture'), work, { recursive: true });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [work, '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-ud-')), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
  });
})().catch((e) => { console.error(e); process.exit(1); });
