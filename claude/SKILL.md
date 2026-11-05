---
name: color-focus
description: Highlight the code you write in VS Code with a Color Focus label. Use whenever the user asks you to solve, implement or work on a named exercise, task, assignment, problem or part (e.g. "solve exercise 1", "do opgave 3", "task 2b", "part A"), or asks you to highlight or label the code you write.
---

# Color Focus: label the code you write

The user's VS Code has the Color Focus extension. While a label is active, every block of code you
add or change with your file-editing tool (Edit/Write in Claude Code, apply_patch in Codex) is
automatically highlighted in VS Code with that label, so the user can find all code for one exercise
later. You only have to turn the label on and off.

## Steps

1. **Before your first edit**, start the label. Use the exercise's name the way the user or the
   assignment writes it, e.g. `Exercise 1`, `Opgave 3b`, `Task 2`:

   ```bash
   ~/.color-focus/bin/color-focus start "Exercise 1"
   ```

   Run it from the project folder (only files under the current folder are highlighted).

2. Solve the exercise as usual, making code changes with your file-editing tool. Highlighting happens
   by itself. Changes made with shell commands (sed, `cat >`, scripts) are not highlighted.

3. **When you are done with that exercise**, stop the label:

   ```bash
   ~/.color-focus/bin/color-focus stop
   ```

   If the user then asks for the next exercise, start its label before editing (step 1).

## Notes

- Only start a label when the work belongs to a named exercise/task, or the user asks for highlighting.
  For general refactoring or unrelated fixes, don't.
- Moving between exercises: `start` with the new name replaces the old label; no need to stop first.
- Run each color-focus command as its own command, with the label in quotes as shown.
- If you changed code for an exercise without a label active (or with a shell command), highlight it
  afterwards (lines are 1-based):

  ```bash
  ~/.color-focus/bin/color-focus add path/to/file.py 12-30 --label "Exercise 1"
  ```

- `~/.color-focus/bin/color-focus status` shows the active label.
- On Windows, use `%USERPROFILE%\.color-focus\bin\color-focus.cmd` instead.
- Don't mention these commands to the user unless they ask; just tell them the code is highlighted as "<label>".
