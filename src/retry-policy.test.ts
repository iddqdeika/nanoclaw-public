import { describe, it, expect } from 'vitest';
import { computeNextRetry, shouldInjectRetryContext, ABSOLUTE_CAP_MS } from './retry-policy.js';

const REF = new Date('2026-05-08T00:00:00Z');

function plus(ms: number): Date {
  return new Date(REF.getTime() + ms);
}

describe('computeNextRetry — network/upstream_5xx', () => {
  it('first attempt: 5s', () => {
    const r = computeNextRetry({
      errorType: 'network',
      attemptCount: 1,
      startedAt: REF,
      now: REF,
    });
    expect(r.nextRetryAt?.getTime()).toBe(REF.getTime() + 5_000);
  });

  it('exponential ladder: 5s, 30s, 2m, 10m, 30m', () => {
    const expected = [5_000, 30_000, 120_000, 600_000, 1_800_000];
    for (let i = 0; i < expected.length; i++) {
      const r = computeNextRetry({
        errorType: 'upstream_5xx',
        attemptCount: i + 1,
        startedAt: REF,
        now: REF,
      });
      expect(r.nextRetryAt?.getTime()).toBe(REF.getTime() + expected[i]);
    }
  });

  it('past ladder: hourly forever (until cap)', () => {
    const r = computeNextRetry({
      errorType: 'network',
      attemptCount: 7,
      startedAt: REF,
      now: REF,
    });
    expect(r.nextRetryAt?.getTime()).toBe(REF.getTime() + 3_600_000);
  });
});

describe('computeNextRetry — rate_limit', () => {
  it('waits until resets_at + 1s buffer', () => {
    const reset = plus(45_000).toISOString();
    const r = computeNextRetry({
      errorType: 'rate_limit',
      attemptCount: 1,
      startedAt: REF,
      now: REF,
      resetsAt: reset,
    });
    expect(r.nextRetryAt?.getTime()).toBe(plus(45_000).getTime() + 1_000);
  });

  it('falls back to 60s when no resets_at', () => {
    const r = computeNextRetry({
      errorType: 'rate_limit',
      attemptCount: 1,
      startedAt: REF,
      now: REF,
    });
    expect(r.nextRetryAt?.getTime()).toBe(REF.getTime() + 60_000);
  });
});

describe('computeNextRetry — non-recoverable types', () => {
  it('auth_401: one retry at 30s, then give up', () => {
    expect(
      computeNextRetry({
        errorType: 'auth_401',
        attemptCount: 1,
        startedAt: REF,
        now: REF,
      }).nextRetryAt?.getTime(),
    ).toBe(REF.getTime() + 30_000);
    expect(
      computeNextRetry({
        errorType: 'auth_401',
        attemptCount: 2,
        startedAt: REF,
        now: REF,
      }).nextRetryAt,
    ).toBeNull();
  });

  it('validation_400: one retry at 60s, then give up', () => {
    expect(
      computeNextRetry({
        errorType: 'validation_400',
        attemptCount: 1,
        startedAt: REF,
        now: REF,
      }).nextRetryAt?.getTime(),
    ).toBe(REF.getTime() + 60_000);
    expect(
      computeNextRetry({
        errorType: 'validation_400',
        attemptCount: 2,
        startedAt: REF,
        now: REF,
      }).nextRetryAt,
    ).toBeNull();
  });

  it('idle_timeout: one retry at 30s, then give up', () => {
    expect(
      computeNextRetry({
        errorType: 'idle_timeout',
        attemptCount: 1,
        startedAt: REF,
        now: REF,
      }).nextRetryAt?.getTime(),
    ).toBe(REF.getTime() + 30_000);
    expect(
      computeNextRetry({
        errorType: 'idle_timeout',
        attemptCount: 2,
        startedAt: REF,
        now: REF,
      }).nextRetryAt,
    ).toBeNull();
  });

  it('crash: 3 retries × 1min, then give up', () => {
    for (let i = 1; i <= 3; i++) {
      expect(
        computeNextRetry({
          errorType: 'crash',
          attemptCount: i,
          startedAt: REF,
          now: REF,
        }).nextRetryAt?.getTime(),
      ).toBe(REF.getTime() + 60_000);
    }
    expect(
      computeNextRetry({
        errorType: 'crash',
        attemptCount: 4,
        startedAt: REF,
        now: REF,
      }).nextRetryAt,
    ).toBeNull();
  });
});

describe('computeNextRetry — 24h absolute cap', () => {
  it('null when now is already past cap', () => {
    const r = computeNextRetry({
      errorType: 'network',
      attemptCount: 1,
      startedAt: REF,
      now: new Date(REF.getTime() + ABSOLUTE_CAP_MS + 1),
    });
    expect(r.nextRetryAt).toBeNull();
    expect(r.giveUpReason).toMatch(/24-hour/);
  });

  it('null when next_retry would land past cap', () => {
    // startedAt = REF, now = 23h59m, network gives 5s → would be 24h+5s past start = past cap
    const now = new Date(REF.getTime() + 23 * 3600_000 + 59 * 60_000);
    const r = computeNextRetry({
      errorType: 'network',
      attemptCount: 7, // hourly tier
      startedAt: REF,
      now,
    });
    expect(r.nextRetryAt).toBeNull();
  });
});

describe('shouldInjectRetryContext', () => {
  it('true for crash/idle_timeout/unknown', () => {
    expect(shouldInjectRetryContext('crash')).toBe(true);
    expect(shouldInjectRetryContext('idle_timeout')).toBe(true);
    expect(shouldInjectRetryContext('unknown')).toBe(true);
  });

  it('false for environmental errors', () => {
    expect(shouldInjectRetryContext('network')).toBe(false);
    expect(shouldInjectRetryContext('rate_limit')).toBe(false);
    expect(shouldInjectRetryContext('upstream_5xx')).toBe(false);
    expect(shouldInjectRetryContext('auth_401')).toBe(false);
    expect(shouldInjectRetryContext('auth_403')).toBe(false);
    expect(shouldInjectRetryContext('validation_400')).toBe(false);
    expect(shouldInjectRetryContext('validation_404')).toBe(false);
  });
});
