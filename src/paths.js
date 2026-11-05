const os = require('os');
const path = require('path');

/** Where Color Focus keeps files shared with other programs (inbox, Claude Code scripts). */
function homeDir() {
  return process.env.COLOR_FOCUS_HOME || path.join(os.homedir(), '.color-focus');
}

module.exports = { homeDir };
