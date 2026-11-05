// Changes to many files at once: remove highlights in a folder, rename a label everywhere.
// Every change can be undone from the message shown afterwards.

const vscode = require('vscode');
const { labelsOf, withLabels } = require('./ranges');

/**
 * deps: {
 *   entries(): [uriString, highlights[]][]
 *   replace(changes: { [uriString]: highlights[] }): void   writes + refreshes everything
 *   colorName(color), swatch(color)
 *   onLabelRenamed(oldName, newName): void
 * }
 */
function createBulk(deps) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---------- which files ----------

  function folderKey(uri) {
    const s = uri.toString();
    return s.endsWith('/') ? s : s + '/';
  }

  function entriesIn(scope) {
    const inside = (key) => (scope.kind === 'all' ? true : scope.kind === 'file' ? key === scope.key : key.startsWith(scope.prefix));
    return deps.entries().filter(([key, list]) => list.length && inside(key));
  }

  function describe(entries) {
    const blocks = entries.reduce((n, [, l]) => n + l.length, 0);
    return `${plural(blocks, 'block')} in ${plural(entries.length, 'file')}`;
  }

  function folderName(uri) {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws && ws.uri.toString() === uri.toString()) return ws.name;
    return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders || []).length > 1);
  }

  /**
   * Where should the change apply? A folder from the Explorer is used directly;
   * otherwise pick "everywhere", a workspace folder, or any folder that contains highlights.
   */
  function fileScope(uri) {
    return { kind: 'file', key: uri.toString(), name: uri.path.split('/').pop() };
  }

  async function isFolder(uri) {
    if (deps.entries().some(([key]) => key === uri.toString())) return false;
    try {
      return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
    } catch {
      return false; // e.g. an unsaved file
    }
  }

  async function pickScope(arg, verb) {
    // From a right-click: the Explorer passes the file/folder, the editor passes its file.
    if (arg instanceof vscode.Uri) {
      return (await isFolder(arg)) ? { kind: 'folder', prefix: folderKey(arg), name: folderName(arg) } : fileScope(arg);
    }
    if (arg && typeof arg === 'object' && arg.file) {
      const root = (vscode.workspace.workspaceFolders || [])[0];
      const isAbs = arg.file.startsWith('/') || /^[a-z]:/i.test(arg.file) || !root;
      return fileScope(isAbs ? vscode.Uri.file(arg.file) : vscode.Uri.joinPath(root.uri, arg.file));
    }
    if (arg && typeof arg === 'object' && 'folder' in arg) {
      // From a keybinding: "folder" is an absolute path, a path relative to the (first) workspace folder, or "" for everywhere.
      if (!arg.folder) return { kind: 'all', name: 'all files' };
      const root = (vscode.workspace.workspaceFolders || [])[0];
      const uri = arg.folder.startsWith('/') || /^[a-z]:/i.test(arg.folder) || !root ? vscode.Uri.file(arg.folder) : vscode.Uri.joinPath(root.uri, arg.folder);
      return { kind: 'folder', prefix: folderKey(uri), name: folderName(uri) };
    }

    const all = { kind: 'all', name: 'all files' };
    const items = [];
    const allEntries = entriesIn(all);
    if (!allEntries.length) {
      vscode.window.showInformationMessage('Color Focus: there are no highlights yet.');
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme !== 'colorfocus-blocks') {
      const here = fileScope(editor.document.uri);
      const inFile = entriesIn(here);
      if (inFile.length) items.push({ label: `$(file)  This file`, description: `${here.name} · ${describe(inFile).split(' in ')[0]}`, scope: here });
    }
    items.push({ label: '$(globe)  Everywhere', description: describe(allEntries), scope: all });

    // Every folder that contains highlighted files (inside the workspace, all parent folders too).
    const folders = new Map();
    const addFolder = (uri) => {
      const key = folderKey(uri);
      if (!folders.has(key)) folders.set(key, uri);
    };
    for (const ws of vscode.workspace.workspaceFolders || []) addFolder(ws.uri);
    for (const [key] of allEntries) {
      const uri = vscode.Uri.parse(key);
      if (uri.scheme !== 'file') continue;
      const ws = vscode.workspace.getWorkspaceFolder(uri);
      let dir = vscode.Uri.joinPath(uri, '..');
      if (!ws) {
        addFolder(dir);
        continue;
      }
      while (dir.path.length >= ws.uri.path.length) {
        addFolder(dir);
        if (dir.path === ws.uri.path) break;
        dir = vscode.Uri.joinPath(dir, '..');
      }
    }
    const folderItems = [...folders.values()]
      .map((uri) => {
        const scope = { kind: 'folder', prefix: folderKey(uri), name: folderName(uri) };
        const inside = entriesIn(scope);
        return inside.length ? { label: `$(folder)  ${scope.name}`, description: describe(inside), scope } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.scope.prefix.localeCompare(b.scope.prefix));
    if (folderItems.length) {
      items.push({ label: 'Folders', kind: vscode.QuickPickItemKind.Separator }, ...folderItems);
    }

    const choice = await vscode.window.showQuickPick(items, { placeHolder: `${verb} where?` });
    return choice && choice.scope;
  }

  // ---------- undo ----------

  function applyWithUndo(changes, message) {
    const before = {};
    const current = new Map(deps.entries());
    for (const key of Object.keys(changes)) before[key] = current.get(key) || [];
    deps.replace(changes);
    // Not awaited: the command finishes now, the Undo button stays available.
    vscode.window.showInformationMessage(message, 'Undo').then((answer) => {
      if (answer === 'Undo') deps.replace(before);
    });
    return { count: Object.keys(changes).length };
  }

  // ---------- remove ----------

  async function removeInFolder(arg) {
    const scope = await pickScope(arg, 'Remove highlights');
    if (!scope) return;
    const entries = entriesIn(scope);
    if (!entries.length) {
      vscode.window.showInformationMessage(`Color Focus: no highlights in ${scope.name}.`);
      return;
    }

    const labels = new Map();
    const colors = new Map();
    let total = 0;
    for (const [, list] of entries) {
      for (const h of list) {
        total++;
        colors.set(h.color, (colors.get(h.color) || 0) + 1);
        for (const l of labelsOf(h)) labels.set(l, (labels.get(l) || 0) + 1);
      }
    }
    const items = [{ label: '$(trash)  All highlights', description: plural(total, 'block'), filter: { kind: 'all' } }];
    if (labels.size) {
      items.push({ label: 'With label', kind: vscode.QuickPickItemKind.Separator });
      for (const [l, n] of [...labels].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        items.push({ label: `◆  ${l}`, description: plural(n, 'block'), filter: { kind: 'label', value: l } });
      }
    }
    items.push({ label: 'With color', kind: vscode.QuickPickItemKind.Separator });
    for (const [c, n] of colors) {
      items.push({ label: `${deps.swatch(c)}  ${deps.colorName(c)}`, description: plural(n, 'block'), filter: { kind: 'color', value: c } });
    }
    const opts = arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) ? arg : {};
    let filter = opts.label ? { kind: 'label', value: opts.label } : opts.color ? { kind: 'color', value: opts.color } : opts.all ? { kind: 'all' } : null;
    if (!filter) {
      const choice = await vscode.window.showQuickPick(items, { placeHolder: `Remove which highlights in ${scope.name}?` });
      if (!choice) return;
      filter = choice.filter;
    }

    // For a label: remove the blocks entirely, or just take the label off them?
    let labelOnly = !!opts.labelOnly;
    if (filter.kind === 'label' && opts.labelOnly === undefined) {
      const how = await vscode.window.showQuickPick(
        [
          { label: '$(trash)  Remove the highlights', description: 'color and all labels disappear', labelOnly: false },
          { label: `$(tag)  Only remove the label "${filter.value}"`, description: 'keep the color and any other labels', labelOnly: true },
        ],
        { placeHolder: `Blocks labeled "${filter.value}"` }
      );
      if (!how) return;
      labelOnly = how.labelOnly;
    }

    const hit = (h) =>
      filter.kind === 'all' || (filter.kind === 'color' ? h.color === filter.value : labelsOf(h).includes(filter.value));
    const changes = {};
    let count = 0;
    let files = 0;
    for (const [key, list] of entries) {
      const n = list.filter(hit).length;
      if (!n) continue;
      count += n;
      files++;
      changes[key] = labelOnly
        ? list.map((h) => (hit(h) ? withLabels(h, labelsOf(h).filter((l) => l !== filter.value)) : h))
        : list.filter((h) => !hit(h));
    }

    if (!count) {
      vscode.window.showInformationMessage(`Color Focus: nothing to remove in ${scope.name}.`);
      return;
    }
    const what = labelOnly ? `the label "${filter.value}" from ${plural(count, 'block')}` : plural(count, 'highlight');
    const ok = opts.confirm === false ? 'Remove' : await vscode.window.showWarningMessage(
      `Remove ${what} in ${plural(files, 'file')} (${scope.name})?`,
      { modal: true, detail: 'You can undo this right after.' },
      'Remove'
    );
    if (ok !== 'Remove') return;
    return applyWithUndo(changes, `Color Focus: removed ${what} in ${plural(files, 'file')}.`);
  }

  // ---------- rename ----------

  async function renameLabel(arg) {
    const scope = await pickScope(arg, 'Rename a label');
    if (!scope) return;
    const entries = entriesIn(scope);

    const labels = new Map();
    for (const [, list] of entries) for (const h of list) for (const l of labelsOf(h)) labels.set(l, (labels.get(l) || 0) + 1);
    if (!labels.size) {
      vscode.window.showInformationMessage(`Color Focus: no labels in ${scope.name}.`);
      return;
    }
    const opts = arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) ? arg : {};
    const pick = opts.from ? { value: opts.from } : await vscode.window.showQuickPick(
      [...labels]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([l, n]) => ({ label: `◆  ${l}`, description: plural(n, 'block'), value: l })),
      { placeHolder: `Rename which label (${scope.name})?` }
    );
    if (!pick) return;
    const oldName = pick.value;

    const everywhere = new Set(deps.entries().flatMap(([, list]) => list.flatMap(labelsOf)));
    const newName = typeof opts.to === 'string' ? opts.to : await vscode.window.showInputBox({
      prompt: `New name for "${oldName}" (${scope.name})`,
      value: oldName,
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return 'Type a name. (To delete a label, use "Remove Highlights in Folder…" → the label → "Only remove the label".)';
        if (t !== oldName && everywhere.has(t)) {
          return { message: `"${t}" already exists. Blocks will be merged into that label.`, severity: vscode.InputBoxValidationSeverity.Info };
        }
        return null;
      },
    });
    if (newName === undefined || newName.trim() === oldName) return;
    const name = newName.trim();

    const changes = {};
    let count = 0;
    let files = 0;
    for (const [key, list] of entries) {
      if (!list.some((h) => labelsOf(h).includes(oldName))) continue;
      files++;
      changes[key] = list.map((h) => {
        if (!labelsOf(h).includes(oldName)) return h;
        count++;
        return withLabels(h, labelsOf(h).map((l) => (l === oldName ? name : l)));
      });
    }
    deps.onLabelRenamed(oldName, name);
    if (!files) return;
    return applyWithUndo(changes, `Color Focus: renamed "${oldName}" → "${name}" on ${plural(count, 'block')} in ${plural(files, 'file')}.`);
  }

  return { removeInFolder, renameLabel, pickScope };
}

module.exports = { createBulk };
