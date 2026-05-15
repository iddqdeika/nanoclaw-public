// PM2 launcher for NanoClaw on Windows.
// PM2's ProcessContainerFork uses require() and cannot load the ESM dist/index.js
// directly — main() never fires because NanoClaw's isDirectRun guard compares
// process.argv[1] to import.meta.url, and they don't match when the module is
// imported via the wrapper. This shim spoofs argv[1] then dynamic-imports the
// ESM entry point so the guard passes. See .claude/skills/windows-ops/SKILL.md.

const path = require('path');

const entry = path.join(__dirname, 'dist', 'index.js');
process.argv[1] = entry;

import(`file://${entry.replace(/\\/g, '/')}`).catch((err) => {
  process.stderr.write(`nanoclaw failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
