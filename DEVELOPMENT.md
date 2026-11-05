# Developing Color Focus

Plain JavaScript, no build step. Source is in `src/`:

| File | What's in it |
| --- | --- |
| `extension.js` | Commands, decorations, focus mode, jumping, labels |
| `ranges.js` | Pure range math (how highlights move with edits, split, merge). Unit tested. |
| `folding.js` | Folding blocks with VS Code's manual folding ranges |
| `blocksView.js` | The read-only "blocks only" stacked view |
| `bulk.js` | Remove / rename across a file, folder or everywhere, with undo |
| `linediff.js` | Line diff: moves highlights after outside changes; finds Claude's changed lines. Unit tested. |
| `snapshots.js` | Remembers the text highlight offsets refer to (memory + disk), for outside changes |
| `inbox.js` | Picks up highlight requests from `~/.color-focus/inbox` |
| `claude.js` | The "Set Up Claude Code Integration" command |

`claude/` holds the Claude Code side: `hook.js` (Pre/PostToolUse hook), `color-focus.js` (start/stop/add command), `SKILL.md`, and `install.js`, which copies them to `~/.color-focus/bin` and `~/.claude`. Run `node claude/install.js install|uninstall|status` to try it without VS Code. Set `COLOR_FOCUS_HOME` / `CLAUDE_CONFIG_DIR` to use other folders.

## Run

Open this folder in VS Code and press `F5`. A second window opens with the extension loaded. Restart it (stop + `F5`) after changing `package.json`.

## Test

```bash
npm install
npm test          # range math, line diff, Claude Code hook + installer
```

The rest run inside a real VS Code window (a throwaway profile; your settings aren't touched). Point `VSCODE_PATH` at VS Code's Electron binary:

```bash
export VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
npm run test:integration   # commands, folding, blocks view, bulk actions
npm run test:keys          # real key presses (Option+Tab shortcuts)
npm run screenshots        # re-renders images/icon.png and the README screenshots
```

## Package

```bash
npm run package
```

Creates `color-focus-<version>.vsix`. Install it with **Extensions → … → Install from VSIX…**.

## Logo

`images/logo.svg` is the source. `npm run screenshots` renders it to `images/icon.png` (256×256).
