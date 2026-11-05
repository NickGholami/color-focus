// Sends real key presses to a test VS Code window (via the Chrome DevTools protocol)
// and checks what the extension did. Usage: VSCODE_PATH=... node test/keys/run.js
const { runTests } = require('@vscode/test-electron');
const path = require('path'), os = require('os'), fs = require('fs');
const root = path.resolve(__dirname, '../..');
const PORT = 9339;
const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-keys-'));

const KEYS = {
  // keyCode = browser key code, mac = macOS virtual key code
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, mac: 48 },
  f: { key: 'f', code: 'KeyF', keyCode: 70, mac: 3, altKey: 'ƒ' },
  h: { key: 'h', code: 'KeyH', keyCode: 72, mac: 4, altKey: '˙' },
  x: { key: 'x', code: 'KeyX', keyCode: 88, mac: 7, altKey: '≈' },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, mac: 125 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, mac: 126 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, mac: 123 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27, mac: 53 },
  c: { key: 'c', code: 'KeyC', keyCode: 67, mac: 8, altKey: 'ç' },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, mac: 36 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, mac: 58 },
};

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.url.includes('workbench'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        let id = 0;
        const pending = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        return (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no devtools page');
}

// press "alt+tab" then "f" (optionally still holding alt)
async function chord(send, second, holdAlt) {
  const ev = async (type, k, mods) => send('Input.dispatchKeyEvent', { type, key: mods && k.altKey ? k.altKey : k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.mac, modifiers: mods });
  await ev('rawKeyDown', KEYS.alt, 1);
  await ev('rawKeyDown', KEYS.tab, 1);
  await ev('keyUp', KEYS.tab, 1);
  if (!holdAlt) await ev('keyUp', KEYS.alt, 0);
  await new Promise((r) => setTimeout(r, 150));
  const m = holdAlt ? 1 : 0;
  await ev('rawKeyDown', KEYS[second], m);
  await ev('keyUp', KEYS[second], m);
  if (holdAlt) await ev('keyUp', KEYS.alt, 0);
}

async function driver() {
  const send = await cdp();
  // The suite writes "step-N" files with what to press; we answer with "done-N".
  for (let n = 0; n < 100; n++) {
    const file = path.join(sync, `step-${n}`);
    while (!fs.existsSync(file)) {
      if (fs.existsSync(path.join(sync, 'finished'))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [second, hold] = fs.readFileSync(file, 'utf8').split(' ');
    if (hold === 'plain' || hold === 'option') {
      // a single key, optionally with Option held (no Option+Tab first)
      const k = KEYS[second];
      const m = hold === 'option' ? 1 : 0;
      const ev = (type, key, mods) => send('Input.dispatchKeyEvent', { type, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.mac, modifiers: mods });
      if (m) await ev('rawKeyDown', KEYS.alt, 1);
      await ev('rawKeyDown', k, m);
      await ev('keyUp', k, m);
      if (m) await ev('keyUp', KEYS.alt, 0);
    } else await chord(send, second, hold === 'hold');
    fs.writeFileSync(path.join(sync, `done-${n}`), '');
  }
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-ws-'));
  fs.cpSync(path.join(root, 'test/fixture'), work, { recursive: true });
  const d = driver().catch((e) => console.error('driver', e));
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    extensionTestsEnv: { CF_SYNC: sync },
    launchArgs: [work, `--remote-debugging-port=${PORT}`, '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-ud-')), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
  });
  fs.writeFileSync(path.join(sync, 'finished'), '');
  await d;
})().catch((e) => { console.error(e); process.exit(1); });
