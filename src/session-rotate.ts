import fs from 'fs';
import path from 'path';

import { DATA_DIR, SESSION_ROTATE_SIZE_BYTES } from './config.js';
import { logger } from './logger.js';

function sessionProjectDir(groupFolder: string): string {
  // The SDK stores per-group sessions under its ~/.claude/projects/<cwd-slug>
  // where <cwd-slug> is the container WORKDIR (/workspace/group) with
  // slashes converted to dashes. This path is stable per container config.
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
}

function sessionJsonlPath(groupFolder: string, sessionId: string): string {
  return path.join(sessionProjectDir(groupFolder), `${sessionId}.jsonl`);
}

/**
 * If the session JSONL for {groupFolder, sessionId} exceeds the configured
 * size cap, move both the .jsonl and its sibling dir into a _rotated/
 * subfolder and return true. The caller is then responsible for clearing
 * the sessions DB row so the next container run starts a fresh session.
 *
 * Returns false if the session is absent (already fresh) or under-cap.
 * Never throws — rotation is best-effort; a failure falls back to the
 * existing (poisoned) session.
 */
export function rotateIfPoisoned(
  groupFolder: string,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return false;
  const jsonl = sessionJsonlPath(groupFolder, sessionId);
  if (!fs.existsSync(jsonl)) return false;

  let size = 0;
  try {
    size = fs.statSync(jsonl).size;
  } catch (err) {
    logger.warn(
      { groupFolder, sessionId, err: (err as Error).message },
      'rotateIfPoisoned: stat failed',
    );
    return false;
  }

  if (size < SESSION_ROTATE_SIZE_BYTES) return false;

  const rotatedDir = path.join(sessionProjectDir(groupFolder), '_rotated');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(rotatedDir, { recursive: true });
    fs.renameSync(jsonl, path.join(rotatedDir, `${sessionId}.${stamp}.jsonl`));
    const sidecar = path.join(sessionProjectDir(groupFolder), sessionId);
    if (fs.existsSync(sidecar)) {
      fs.renameSync(
        sidecar,
        path.join(rotatedDir, `${sessionId}.${stamp}.dir`),
      );
    }
    logger.warn(
      {
        groupFolder,
        sessionId,
        sizeBytes: size,
        threshold: SESSION_ROTATE_SIZE_BYTES,
      },
      'Session JSONL over size cap — rotated to start fresh (prevents autocompact thrash)',
    );
    return true;
  } catch (err) {
    logger.warn(
      { groupFolder, sessionId, err: (err as Error).message },
      'rotateIfPoisoned: rename failed — continuing with existing session',
    );
    return false;
  }
}
