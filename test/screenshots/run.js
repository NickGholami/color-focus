// Takes the README screenshots and renders the logo, using a test VS Code window.
// Usage: VSCODE_PATH=".../Visual Studio Code.app/Contents/MacOS/Electron" node test/screenshots/run.js
const { runTests } = require('@vscode/test-electron');
const path = require('path'), os = require('os'), fs = require('fs');
const root = path.resolve(__dirname, '../..');
const PORT = 9341;
const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shots-'));
const outDir = path.join(root, 'images');

async function connect() {
  for (let i = 0; i < 80; i++) {
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

// Draw an SVG onto a canvas inside the page and return PNG bytes.
async function renderSvg(send, svg, size) {
  const expr = `new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return Buffer.from(r.result.result.value, 'base64');
}

async function driver() {
  const send = await connect();
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false });

  const svg = fs.readFileSync(path.join(outDir, 'logo.svg'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'icon.png'), await renderSvg(send, svg, 256));
  fs.writeFileSync(path.join(sync, 'logo-done'), '');

  for (let n = 0; n < 50; n++) {
    const file = path.join(sync, `shot-${n}`);
    while (!fs.existsSync(file)) {
      if (fs.existsSync(path.join(sync, 'finished'))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const name = fs.readFileSync(file, 'utf8');
    // Leave out the title bar (it says "Extension Development Host" in test windows).
    const m = await send('Runtime.evaluate', { expression: `(() => { const t = document.querySelector('.part.titlebar'); return [t ? t.offsetHeight : 0, innerWidth, innerHeight]; })()`, returnByValue: true });
    const [top, w, h] = m.result.result.value;
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: top, width: w, height: h - top, scale: 1 } });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    fs.writeFileSync(path.join(sync, `done-${n}`), '');
  }
}

(async () => {
  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-demo-')), 'physics-course');
  fs.cpSync(path.join(__dirname, 'sample'), path.join(work, 'week3'), { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'color-focus-ud-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.layoutControl.enabled': false,
    'editor.minimap.enabled': false,
    'editor.fontSize': 14,
    'editor.lineHeight': 21,
    'breadcrumbs.enabled': false,
    'window.commandCenter': false,
    'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'editor.stickyScroll.enabled': false,
    'editor.guides.indentation': false,
    'files.exclude': { '**/.vscode': true },
    'window.title': '${activeEditorShort} — ${rootName}',
    'workbench.statusBar.visible': true,
  }));
  const d = driver().catch((e) => console.error('driver', e));
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    extensionTestsEnv: { CF_SYNC: sync },
    launchArgs: [work, `--remote-debugging-port=${PORT}`, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
  });
  fs.writeFileSync(path.join(sync, 'finished'), '');
  await d;
})().catch((e) => { console.error(e); process.exit(1); });
