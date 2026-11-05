// Replays the real Claude Code session that solved the demo exercises (grades.py),
// with the same steps the hook and the extension take, and checks every label ends up right.
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/linediff');
const R = require('../src/ranges');

const original = `"""A tiny grade book for a course."""

def average(grades):
    """Return the average of a list of grades."""
    return sum(grades) / len(grades)


def has_passed(grades):
    """A student passes if their average is at least PASS_LIMIT."""
    return average(grades) >= PASS_LIMIT


def print_report():
    for name, grades in students.items():
        status = "passed" if has_passed(grades) else "failed"
        print(f"{name:<8} {average(grades):5.2f}  {status}")


if __name__ == "__main__":
    print_report()
`;

// [label, old_string, new_string] exactly as Claude sent them
const edits = [
  ['Exercise 1', '    return average(grades) >= PASS_LIMIT\n\n\ndef print_report():', '    return average(grades) >= PASS_LIMIT\n\n\ndef add_grade(name, grade):\n    """Add a grade to a student, creating the student if needed."""\n    if grade not in VALID_GRADES:\n        raise ValueError(f"Invalid grade {grade!r}; must be one of {VALID_GRADES}")\n    students.setdefault(name, []).append(grade)\n\n\ndef print_report():'],
  ['Exercise 2', '    students.setdefault(name, []).append(grade)\n\n\ndef print_report():', '    students.setdefault(name, []).append(grade)\n\n\ndef best_student():\n    """Return the name of the student with the highest average."""\n    return max(students, key=lambda name: average(students[name]))\n\n\ndef print_report():'],
  ['Exercise 2', '        print(f"{name:<8} {average(grades):5.2f}  {status}")\n', '        print(f"{name:<8} {average(grades):5.2f}  {status}")\n    print("-" * 30)\n    print(f"Best student: {best_student()}")\n'],
  ['Exercise 3', '    """Return the average of a list of grades."""\n    return sum(grades) / len(grades)', '    """Return the average of a list of grades, or None if the list is empty."""\n    if not grades:\n        return None\n    return sum(grades) / len(grades)'],
  ['Exercise 3', '    """A student passes if their average is at least PASS_LIMIT."""\n    return average(grades) >= PASS_LIMIT', '    """A student passes if their average is at least PASS_LIMIT.\n\n    A student without grades has not passed.\n    """\n    avg = average(grades)\n    return avg is not None and avg >= PASS_LIMIT'],
  ['Exercise 3', '    """Return the name of the student with the highest average."""\n    return max(students, key=lambda name: average(students[name]))', '    """Return the name of the student with the highest average.\n\n    Students without grades are skipped; returns None if nobody has grades.\n    """\n    graded = [name for name, grades in students.items() if grades]\n    if not graded:\n        return None\n    return max(graded, key=lambda name: average(students[name]))'],
  ['Exercise 3', '        status = "passed" if has_passed(grades) else "failed"\n        print(f"{name:<8} {average(grades):5.2f}  {status}")\n    print("-" * 30)\n    print(f"Best student: {best_student()}")', '        avg = average(grades)\n        if avg is None:\n            print(f"{name:<8} no grades")\n            continue\n        status = "passed" if has_passed(grades) else "failed"\n        print(f"{name:<8} {avg:5.2f}  {status}")\n    print("-" * 30)\n    best = best_student()\n    print(f"Best student: {best if best is not None else \'none\'}")'],
];

test('replay of the grades.py session: every line keeps all its exercises', () => {
  let text = original;
  let hs = [];
  const colors = { 'Exercise 1': 'orange', 'Exercise 2': 'yellow', 'Exercise 3': 'teal' };
  for (const [label, from, to] of edits) {
    assert.ok(text.includes(from), `edit applies: ${from.slice(0, 40)}`);
    const next = text.replace(from, to);
    hs = D.remapByDiff(hs, text, next); // VS Code reloads the file
    const { starts, lines } = D.splitLines(next);
    for (const b of D.changedBlocks(text, next)) { // the hook + inbox
      hs = R.addLabeled(hs, starts[b.start], starts[b.end] + lines[b.end].length, colors[label], [label]);
    }
    text = next;
  }
  // Labels per line, like the editor shows them.
  const { starts, lines } = D.splitLines(text);
  const labelsAt = (i) => {
    const s = starts[i], e = s + lines[i].length;
    return [...new Set(hs.filter((h) => h.start <= e && h.end >= s && h.end > s).flatMap((h) => h.labels))].sort().join('+');
  };
  const view = lines.map((l, i) => `${labelsAt(i).padEnd(22)}|${l}`).join('\n');
  const want = (code, labels) => {
    const i = lines.indexOf(code);
    assert.ok(i >= 0, `line exists: ${code}`);
    assert.strictEqual(labelsAt(i), labels, `${code}\n\n${view}`);
  };
  want('def add_grade(name, grade):', 'Exercise 1');
  want('def best_student():', 'Exercise 2');
  want('    """Return the name of the student with the highest average.', 'Exercise 2+Exercise 3');
  want('    graded = [name for name, grades in students.items() if grades]', 'Exercise 2+Exercise 3');
  want('    return max(graded, key=lambda name: average(students[name]))', 'Exercise 2+Exercise 3');
  want('    print("-" * 30)', 'Exercise 2+Exercise 3');
  want('    best = best_student()', 'Exercise 2+Exercise 3');
  want('    print(f"Best student: {best if best is not None else \'none\'}")', 'Exercise 2+Exercise 3');
  want('        avg = average(grades)', 'Exercise 3');
  want('    return sum(grades) / len(grades)', '');
  want('def print_report():', '');
});
