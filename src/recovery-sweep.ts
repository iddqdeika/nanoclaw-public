/**
 * Recovery sweep loop + boot hook.
 *
 * Runs once a minute (configurable via RECOVERY_SWEEP_INTERVAL_MS).
 *
 *  1. Query sessions table for rows where next_retry_at <= now.
 *  2. For each, trigger a turn replay via the standard message-processing
 *     path (sourceJid + getMessagesSince — coalesces any newer messages
 *     since the failure naturally).
 *  3. Group-queue serializes — sequential per group, oldest in_flight_since
 *     first across groups.
 *
 * Boot hook resets stale locks: any row with `in_flight_since` set but no
 * scheduled retry (or scheduled in the future past the cap) gets pushed
 * to next_retry_at = now so the next sweep picks it up.
 */

import {
  getDueRecoveries,
  getAllInFlight,
  resetStaleRecoveryLocks,
  RecoveryRow,
} from './db.js';
import { logger } from './logger.js';

const SWEEP_INTERVAL_MS = parseInt(
  process.env.RECOVERY_SWEEP_INTERVAL_MS || '60000',
  10,
);

export interface SweepDeps {
  /** Trigger a turn replay for the given group folder. */
  triggerReplay: (row: RecoveryRow) => Promise<void>;
}

let sweepRunning = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic sweep. Idempotent.
 */
export function startRecoverySweep(deps: SweepDeps): void {
  if (sweepRunning) {
    logger.debug('recovery sweep already running, skipping duplicate start');
    return;
  }
  sweepRunning = true;
  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS },
    'recovery sweep loop started',
  );

  const tick = async () => {
    try {
      const due = getDueRecoveries();
      if (due.length === 0) return;
      logger.info(
        { count: due.length },
        'recovery sweep: dispatching pending retries',
      );
      // Process sequentially — group-queue serializes per group anyway,
      // and the sweep loop itself runs single-threaded.
      for (const row of due) {
        try {
          await deps.triggerReplay(row);
        } catch (err) {
          logger.error(
            {
              groupFolder: row.group_folder,
              threadId: row.thread_id,
              err: (err as Error).message,
            },
            'recovery sweep: triggerReplay threw',
          );
        }
      }
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'recovery sweep tick failed',
      );
    }
  };

  // Fire once immediately on startup (covers freshly-set retries from boot
  // hook), then on the interval.
  setTimeout(tick, 5_000).unref?.();
  sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopRecoverySweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepRunning = false;
}

/**
 * Boot hook — called once on orchestrator startup before sweep begins.
 * Finds rows with stale in_flight_since (lock left over from a previous
 * orchestrator instance) and schedules them for immediate retry.
 *
 * Without this, after a pm2 restart, the in-process retry counter in DB
 * may be set but next_retry_at could still point at the future — the row
 * would idle until the natural retry time arrives. Boot hook collapses
 * "I came back online" → immediate retry attempt.
 */
export function runRecoveryBootHook(): { unlocked: number; inFlight: number } {
  const inFlight = getAllInFlight();
  const unlocked = resetStaleRecoveryLocks();
  logger.info(
    { inFlight: inFlight.length, unlocked },
    'recovery boot hook: rescheduled stale locks for immediate sweep',
  );
  return { unlocked, inFlight: inFlight.length };
}
