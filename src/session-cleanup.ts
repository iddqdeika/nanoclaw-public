import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, ONESHOT_RETENTION_DAYS } from './config.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');

function runCleanup(): void {
  execFile('/bin/bash', [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      logger.error({ err }, 'Session cleanup failed');
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) logger.info(summary);
  });

  cleanupOneshotWorkspaces();
}

function cleanupOneshotWorkspaces(): void {
  const oneshotDir = path.join(DATA_DIR, 'oneshot');
  if (!fs.existsSync(oneshotDir)) return;

  const cutoff = Date.now() - ONESHOT_RETENTION_DAYS * 86400_000;
  let cleaned = 0;

  try {
    for (const entry of fs.readdirSync(oneshotDir)) {
      const dir = path.join(oneshotDir, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          // Also clean up the corresponding sessions dir
          const sessionsDir = path.join(
            DATA_DIR,
            'sessions',
            `oneshot-${entry}`,
          );
          if (fs.existsSync(sessionsDir)) {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
          }
          cleaned++;
        }
      } catch (err) {
        logger.warn({ entry, err }, 'Failed to clean up oneshot workspace');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to read oneshot directory for cleanup');
  }

  if (cleaned > 0) {
    logger.info(
      { cleaned, retentionDays: ONESHOT_RETENTION_DAYS },
      'Cleaned up oneshot workspaces',
    );
  }
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
