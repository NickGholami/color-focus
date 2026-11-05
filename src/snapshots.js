// Remembers, per file with highlights, the text that the highlight offsets refer to.
// When the file changes outside VS Code (Claude Code, git, another editor), the old and new
// text are compared line by line to move the highlights (see linediff.remapByDiff).
// Kept in memory for open files and saved to disk, so changes made while a file is closed are caught too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createSnapshots(storageDir) {
  const dir = path.join(storageDir, 'snapshots');
  const memory = new Map(); // key -> text
  const pending = new Set(); // keys to write on the next flush

  const fileOf = (key) => path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + '.txt');

  function readDisk(key) {
    try {
      return fs.readFileSync(fileOf(key), 'utf8');
    } catch {
      return undefined;
    }
  }

  return {
    /** Is the text tracked in memory (file is open)? */
    has: (key) => memory.has(key),
    /** The known text: from memory, or the copy saved on disk. */
    get: (key) => (memory.has(key) ? memory.get(key) : readDisk(key)),
    update(key, text) {
      memory.set(key, text);
      pending.add(key);
    },
    forget(key) {
      memory.delete(key);
      pending.delete(key);
      try { fs.unlinkSync(fileOf(key)); } catch {}
    },
    rename(oldKey, newKey) {
      const text = memory.has(oldKey) ? memory.get(oldKey) : readDisk(oldKey);
      this.forget(oldKey);
      if (text !== undefined) this.update(newKey, text);
    },
    /** Write pending texts to disk; files without highlights (hasHighlights false) lose their copy. */
    flush(hasHighlights) {
      if (!pending.size) return;
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      for (const key of pending) {
        try {
          if (hasHighlights(key) && memory.has(key)) fs.writeFileSync(fileOf(key), memory.get(key));
          else fs.unlinkSync(fileOf(key));
        } catch {}
      }
      pending.clear();
    },
    /** The file was closed: save its copy and stop tracking it in memory. */
    release(key, hasHighlights) {
      if (!memory.has(key)) return;
      if (pending.has(key)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          if (hasHighlights(key)) fs.writeFileSync(fileOf(key), memory.get(key));
          else fs.unlinkSync(fileOf(key));
        } catch {}
        pending.delete(key);
      }
      memory.delete(key);
    },
  };
}

module.exports = { createSnapshots };
