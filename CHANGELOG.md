# Changelog

## 1.1.0

- **Claude Code and Codex integration.** Tell Claude Code or Codex "solve exercise 1" and every block of code it writes or changes is highlighted and labeled "Exercise 1". Set it up with **Color Focus: Set Up Claude Code Integration…** or **Color Focus: Set Up Codex Integration…**.
- Highlights now follow changes made outside VS Code (Claude Code, Codex, git, other editors), also while the file is closed.
- Code the agent changes again for a later exercise keeps its earlier label and gets the new one too.
- Other programs can add highlights by dropping a small JSON file into `~/.color-focus/inbox`.

## 1.0.0

First public release.

- Color any block of code with a background color that stays, follows edits and is saved between sessions. Works in every language.
- One or more labels per block, shown next to the block and on hover.
- Focus mode: fade out everything except one color, one label, or all highlights.
- "Show Highlighted Blocks Only": stack matching blocks from one file or the whole workspace in one read-only view, with links back to the code.
- Fold any block, even one that crosses function boundaries.
- Jump between blocks and keep jumping with the arrow keys.
- Remove highlights and rename labels in a file, folder or everywhere, with Undo.
- Keyboard shortcuts on Option+Tab (Mac) and Ctrl+Alt (Windows/Linux) that don't clash with VS Code's own.
