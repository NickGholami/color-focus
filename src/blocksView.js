// "Blocks only" view: a read-only document that stacks highlighted blocks after each other,
// from one file or from every file in the workspace, filtered by label or color.

const vscode = require('vscode');
const { labelsOf } = require('./ranges');

const SCHEME = 'colorfocus-blocks';

// How to write a one-line comment in common languages, so headers don't break syntax colors.
const COMMENTS = {};
const addComments = (langs, open, close = '') => langs.forEach((l) => (COMMENTS[l] = [open, close]));
addComments(['python', 'shellscript', 'ruby', 'perl', 'r', 'yaml', 'toml', 'dockerfile', 'makefile', 'powershell', 'julia', 'coffeescript', 'elixir', 'nim', 'cmake', 'properties', 'gdscript', 'raku', 'tcl', 'awk'], '# ');
addComments(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'java', 'c', 'cpp', 'cuda-cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin', 'scala', 'dart', 'php', 'objective-c', 'objective-cpp', 'groovy', 'jsonc', 'less', 'scss', 'fsharp', 'zig', 'solidity', 'verilog', 'systemverilog', 'glsl', 'hlsl', 'arduino', 'proto', 'v', 'odin', 'haxe', 'apex'], '// ');
addComments(['fortran', 'fortran-modern', 'FortranFreeForm', 'FortranFixedForm', 'fortran_fixed-form', 'fortran_free-form'], '! ');
addComments(['sql', 'lua', 'haskell', 'ada', 'elm', 'vhdl', 'purescript', 'agda'], '-- ');
addComments(['latex', 'tex', 'bibtex', 'matlab', 'octave', 'erlang', 'prolog', 'postscript'], '% ');
addComments(['lisp', 'clojure', 'scheme', 'racket', 'asm', 'nasm', 'ini', 'autohotkey'], '; ');
addComments(['vb', 'vba'], "' ");
addComments(['css', 'c-like-block'], '/* ', ' */');
addComments(['html', 'xml', 'markdown', 'svelte', 'vue', 'xsl', 'razor', 'php-html'], '<!-- ', ' -->');
addComments(['bat'], 'REM ');

/**
 * deps: {
 *   entries(): [uriString, highlights[]][]   all stored highlights
 *   toRange(doc, h), colorName(color), swatch(color), decorationFor(color)
 * }
 */
function createBlocksView(deps) {
  const changed = new vscode.EventEmitter();
  /** blocks-doc uri -> [{ header, start, end, source, sourceLine, color }] (lines in the blocks doc) */
  const segments = new Map();
  const headerDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    fontWeight: 'bold',
    borderWidth: '1px 0 0 0',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorWidget.border'),
  });
  let refreshTimer;

  // ---------- which blocks ----------

  function matches(h, filter) {
    if (filter.kind === 'color') return h.color === filter.value;
    if (filter.kind === 'label') return labelsOf(h).includes(filter.value);
    return true;
  }

  function inScope(uriString, scope) {
    if (scope.kind === 'file') return uriString === scope.file;
    return !!vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uriString));
  }

  function scopedEntries(scope) {
    return deps.entries().filter(([uri, list]) => list.length && inScope(uri, scope));
  }

  // ---------- building the document ----------

  async function build(uri) {
    const { scope, filter } = JSON.parse(uri.query);
    const files = [];
    for (const [uriString, list] of scopedEntries(scope)) {
      const blocks = list.filter((h) => matches(h, filter));
      if (!blocks.length) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
        files.push({ doc, blocks: [...blocks].sort((a, b) => a.start - b.start) });
      } catch {
        // File was deleted or can't be read: skip it.
      }
    }
    files.sort((a, b) => relPath(a.doc.uri).localeCompare(relPath(b.doc.uri)));

    const languages = new Set(files.map((f) => f.doc.languageId));
    const language = languages.size === 1 ? [...languages][0] : 'plaintext';
    const [open, close] = COMMENTS[language] || ['', ''];
    const comment = (text) => `${open}${text}${close}`;

    const count = files.reduce((n, f) => n + f.blocks.length, 0);
    const lines = [
      comment(`Color Focus · ${filterTitle(filter)} · ${count} block${count === 1 ? '' : 's'}${scope.kind === 'workspace' ? ` in ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`),
      comment('Read-only. F12 or the "Open" link above a block jumps to the original code.'),
    ];
    const segs = [];
    let n = 0;
    for (const { doc, blocks } of files) {
      for (const h of blocks) {
        const r = deps.toRange(doc, h);
        const from = r.start.line;
        const to = r.end.line;
        n++;
        lines.push('');
        const parts = [`${n}. ${relPath(doc.uri)}:${from + 1}${to > from ? `–${to + 1}` : ''}`];
        if (labelsOf(h).length) parts.push(labelsOf(h).map((l) => `◆ ${l}`).join(' '));
        parts.push(deps.colorName(h.color));
        const header = lines.length;
        lines.push(comment(`━━ ${parts.join('  ·  ')} ━━`));
        for (let l = from; l <= to; l++) lines.push(doc.lineAt(l).text);
        segs.push({ header, start: header + 1, end: lines.length - 1, source: doc.uri, sourceLine: from, color: h.color });
      }
    }
    if (!segs.length) {
      lines.push('', comment('No highlighted blocks match this filter (yet).'));
    }

    segments.set(uri.toString(), segs);
    return { text: lines.join('\n') + '\n', language };
  }

  function relPath(uri) {
    // Only prefix the folder name when several folders are open.
    const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
    return uri.scheme === 'file' ? vscode.workspace.asRelativePath(uri, multiRoot) : uri.path.split('/').pop();
  }

  function filterTitle(filter) {
    if (filter.kind === 'label') return `◆ ${filter.value}`;
    if (filter.kind === 'color') return deps.colorName(filter.value);
    return 'All highlights';
  }

  const languageFor = new Map(); // blocks-doc uri -> language from the last build

  const contentProvider = {
    onDidChange: changed.event,
    async provideTextDocumentContent(uri) {
      const { text, language } = await build(uri);
      languageFor.set(uri.toString(), language);
      return text;
    },
  };

  // ---------- showing it ----------

  async function open(scope, filter) {
    const where = scope.kind === 'file' ? vscode.Uri.parse(scope.file).path.split('/').pop() : 'all files';
    const name = `Blocks · ${filterTitle(filter)} · ${where}`.replace(/[\\/:*?"<>|]/g, '-');
    const uri = vscode.Uri.from({ scheme: SCHEME, path: '/' + name, query: JSON.stringify({ scope, filter }) });
    let doc = await vscode.workspace.openTextDocument(uri);
    const language = languageFor.get(uri.toString());
    if (language && doc.languageId !== language) {
      doc = await vscode.languages.setTextDocumentLanguage(doc, language);
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    render(editor);
  }

  function render(editor) {
    if (editor.document.uri.scheme !== SCHEME) return false;
    const segs = segments.get(editor.document.uri.toString()) || [];
    editor.setDecorations(headerDecoration, segs.map((s) => new vscode.Range(s.header, 0, s.header, 0)));

    const byColor = new Map();
    for (const s of segs) {
      if (s.end < s.start) continue;
      if (!byColor.has(s.color)) byColor.set(s.color, []);
      byColor.get(s.color).push(new vscode.Range(s.start, 0, s.end, 0));
    }
    deps.clearOtherColors(editor, byColor);
    for (const [color, ranges] of byColor) editor.setDecorations(deps.decorationFor(color), ranges);
    return true;
  }

  /** Highlights changed somewhere: refresh open blocks views (batched). */
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === SCHEME) changed.fire(doc.uri);
      }
    }, 300);
  }

  // ---------- jumping to the source ----------

  function segmentAt(doc, line) {
    const segs = segments.get(doc.uri.toString()) || [];
    return segs.find((s) => line >= s.header && line <= s.end);
  }

  async function openSource(source, line) {
    const uri = typeof source === 'string' ? vscode.Uri.parse(source) : source;
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.Active });
  }

  async function goToSource() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== SCHEME) return;
    const line = editor.selection.active.line;
    const seg = segmentAt(editor.document, line);
    if (!seg) return;
    await openSource(seg.source, seg.sourceLine + Math.max(0, line - seg.start));
  }

  const codeLenses = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      return (segments.get(doc.uri.toString()) || []).map((s) => {
        const name = s.source.path.split('/').pop();
        return new vscode.CodeLens(new vscode.Range(s.header, 0, s.header, 0), {
          title: `$(go-to-file) Open ${name}:${s.sourceLine + 1}`,
          command: 'colorFocus.openSource',
          arguments: [s.source.toString(), s.sourceLine],
        });
      });
    },
  };

  const folding = {
    onDidChangeFoldingRanges: changed.event,
    provideFoldingRanges(doc) {
      return (segments.get(doc.uri.toString()) || [])
        .filter((s) => s.end > s.header)
        .map((s) => new vscode.FoldingRange(s.header, s.end, vscode.FoldingRangeKind.Region));
    },
  };

  // ---------- picking what to show ----------

  /**
   * args (optional, e.g. from a keybinding) skip the pickers:
   * { scope: 'file' | 'workspace', label?: string, color?: string }
   */
  async function pick(args) {
    const editor = vscode.window.activeTextEditor;
    const current = editor && editor.document.uri.scheme !== SCHEME ? editor.document.uri.toString() : null;
    const fileScope = current && { kind: 'file', file: current };
    const wsScope = vscode.workspace.workspaceFolders ? { kind: 'workspace' } : null;

    if (args && typeof args === 'object' && args.scope) {
      const scope = args.scope === 'file' ? fileScope : wsScope;
      if (!scope) return;
      const filter = args.label ? { kind: 'label', value: args.label } : args.color ? { kind: 'color', value: args.color } : { kind: 'all' };
      return open(scope, filter);
    }

    const total = (scope) => scopedEntries(scope).reduce((n, [, l]) => n + l.length, 0);
    const scopes = [];
    if (fileScope && total(fileScope)) {
      scopes.push({ label: '$(file)  This file', description: `${editor.document.uri.path.split('/').pop()} · ${total(fileScope)} blocks`, scope: fileScope });
    }
    if (wsScope && total(wsScope)) {
      const files = scopedEntries(wsScope).length;
      scopes.push({ label: '$(folder)  All files in this workspace', description: `${total(wsScope)} blocks in ${files} file${files === 1 ? '' : 's'}`, scope: wsScope });
    }
    if (!scopes.length) {
      vscode.window.showInformationMessage('Color Focus: no highlighted blocks to show yet.');
      return;
    }
    const scopeChoice = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { placeHolder: 'Show blocks from…' });
    if (!scopeChoice) return;

    const all = scopedEntries(scopeChoice.scope).flatMap(([, l]) => l);
    const labels = new Map();
    const colors = new Map();
    for (const h of all) {
      colors.set(h.color, (colors.get(h.color) || 0) + 1);
      for (const l of labelsOf(h)) labels.set(l, (labels.get(l) || 0) + 1);
    }
    const blocks = (n) => `${n} block${n === 1 ? '' : 's'}`;
    const items = [{ label: '$(list-flat)  All highlights', description: blocks(all.length), filter: { kind: 'all' } }];
    if (labels.size) {
      items.push({ label: 'Labels', kind: vscode.QuickPickItemKind.Separator });
      for (const [label, n] of [...labels].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        items.push({ label: `◆  ${label}`, description: blocks(n), filter: { kind: 'label', value: label } });
      }
    }
    items.push({ label: 'Colors', kind: vscode.QuickPickItemKind.Separator });
    for (const [color, n] of colors) {
      items.push({ label: `${deps.swatch(color)}  ${deps.colorName(color)}`, description: blocks(n), filter: { kind: 'color', value: color } });
    }

    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Show only blocks with…' });
    if (choice) await open(scopeChoice.scope, choice.filter);
  }

  const disposables = [
    changed,
    headerDecoration,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, codeLenses),
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, folding),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== SCHEME) return;
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) render(ed);
    }),
  ];

  /** Line spans of the stacked blocks (header line through last code line), for jumping. */
  function spans(doc) {
    return (segments.get(doc.uri.toString()) || []).map((s) => ({ start: s.header, end: s.end }));
  }

  return { SCHEME, spans, pick, render, refresh, goToSource, openSource, dispose: () => disposables.forEach((d) => d.dispose()) };
}

module.exports = { createBlocksView };
