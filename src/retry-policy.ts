/**
 * Retry policy for failed turns.
 *
 * Pure function: (error_type, attempt_count, started_at, resets_at?) →
 * { next_retry_at | null, give_up_reason? }.
 *
 * `null` for next_retry_at = budget exhausted, give up now.
 *
 * Two rules apply simultaneously:
 *   1. Per-error-type schedule (adaptive intensity).
 *   2. Absolute 24h cap from `started_at` (the moment the turn first failed).
 *      If next_retry_at would exceed started_at+24h, return null instead.
 */

import { ErrorType } from './error-classifier.js';

export const ABSOLUTE_CAP_MS = 24 * 60 * 60 * 1000; // 24h

export interface RetryPolicyInput {
  errorType: ErrorType;
  /** How many attempts have already failed (1 after the first failure). */
  attemptCount: number;
  /** When the turn first failed (cap is started_at + 24h). */
  startedAt: Date;
  /** Anthropic rate-limit reset, if known. */
  resetsAt?: string;
  /** Current time — injectable for testing. */
  now?: Date;
}

export interface RetryPolicyResult {
  /** When to retry next. null = give up. */
  nextRetryAt: Date | null;
  /** When giving up, a short reason for the user-facing give-up message. */
  giveUpReason?: string;
}

/**
 * Compute the next retry time per policy. `null` = give up.
 *
 * Policy:
 *  - network / upstream_5xx: exp [5s, 30s, 2m, 10m, 30m], then hourly. 24h cap.
 *  - rate_limit: wait until resets_at, else +60s as fallback. 24h cap.
 *  - auth_401 / auth_403: +30s once, then give up.
 *  - validation_400 / validation_404: +60s once, then give up.
 *  - crash: +1m three times, then give up.
 *  - idle_timeout: +30s once, then give up.
 *  - unknown: treated as crash.
 */
export function computeNextRetry(input: RetryPolicyInput): RetryPolicyResult {
  const now = input.now ?? new Date();
  const deadline = new Date(input.startedAt.getTime() + ABSOLUTE_CAP_MS);

  if (now >= deadline) {
    return {
      nextRetryAt: null,
      giveUpReason: '24-hour recovery budget exhausted',
    };
  }

  const schedule = computeNextOffsetMs(input.errorType, input.attemptCount, input.resetsAt, now);
  if (schedule == null) {
    return {
      nextRetryAt: null,
      giveUpReason: `${input.errorType} retry budget exhausted (${input.attemptCount} attempts)`,
    };
  }

  const candidate = new Date(now.getTime() + schedule.offsetMs);
  if (candidate >= deadline) {
    return {
      nextRetryAt: null,
      giveUpReason: '24-hour recovery budget exhausted',
    };
  }

  return { nextRetryAt: candidate };
}

function computeNextOffsetMs(
  errorType: ErrorType,
  attemptCount: number,
  resetsAt: string | undefined,
  now: Date,
): { offsetMs: number } | null {
  switch (errorType) {
    case 'network':
    case 'upstream_5xx': {
      // exp [5s, 30s, 2m, 10m, 30m], then hourly forever (until cap)
      const ladder = [5_000, 30_000, 120_000, 600_000, 1_800_000];
      if (attemptCount <= ladder.length) {
        return { offsetMs: ladder[attemptCount - 1] };
      }
      return { offsetMs: 3_600_000 };
    }

    case 'rate_limit': {
      // Wait until resets_at if Anthropic gave us one; otherwise 60s.
      if (resetsAt) {
        const target = new Date(resetsAt);
        if (!isNaN(target.getTime())) {
          const ms = Math.max(0, target.getTime() - now.getTime()) + 1_000; // +1s buffer
          return { offsetMs: ms };
        }
      }
      // Fallback: 60s exponential up to 30min
      const ladder = [60_000, 180_000, 600_000, 1_800_000];
      if (attemptCount <= ladder.length) {
        return { offsetMs: ladder[attemptCount - 1] };
      }
      return { offsetMs: 1_800_000 };
    }

    case 'auth_401':
    case 'auth_403': {
      // 30s, then give up
      if (attemptCount <= 1) return { offsetMs: 30_000 };
      return null;
    }

    case 'validation_400':
    case 'validation_404': {
      // 60s, then give up
      if (attemptCount <= 1) return { offsetMs: 60_000 };
      return null;
    }

    case 'idle_timeout': {
      // 30s, then give up
      if (attemptCount <= 1) return { offsetMs: 30_000 };
      return null;
    }

    case 'crash':
    case 'unknown': {
      // 1min × 3, then give up
      if (attemptCount <= 3) return { offsetMs: 60_000 };
      return null;
    }
  }
}

/**
 * True when this error type warrants prepending a retry_context block to
 * the user prompt. Used only for failure modes the agent itself can do
 * something about (crash / idle_timeout). Environmental errors are not
 * the agent's concern.
 */
export function shouldInjectRetryContext(errorType: ErrorType): boolean {
  return errorType === 'crash' || errorType === 'idle_timeout' || errorType === 'unknown';
}
