/**
 * State-transition tests for the recovery DB helpers.
 *
 * Uses the in-memory test DB (_initTestDatabase) — no external state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  markTurnInFlight,
  scheduleRetry,
  clearRecoveryState,
  getRecoveryStateForTurn,
  getDueRecoveries,
  getAllInFlight,
  resetStaleRecoveryLocks,
} from './db.js';

describe('recovery state transitions', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('markTurnInFlight creates a row with stable pending anchor', () => {
    markTurnInFlight('slack_main', 'thread_a', 'msg_42');
    const row = getRecoveryStateForTurn('slack_main', 'thread_a');
    expect(row).not.toBeNull();
    expect(row?.pending_since_message_id).toBe('msg_42');
    expect(row?.in_flight_since).not.toBeNull();
    expect(row?.attempt_count).toBe(0);
  });

  it('markTurnInFlight is idempotent — anchor stays stable across calls', () => {
    markTurnInFlight('slack_main', 'thread_a', 'msg_42');
    const first = getRecoveryStateForTurn('slack_main', 'thread_a');
    markTurnInFlight('slack_main', 'thread_a', 'msg_99');
    const second = getRecoveryStateForTurn('slack_main', 'thread_a');
    // Anchor preserved from first call
    expect(second?.pending_since_message_id).toBe('msg_42');
    expect(second?.in_flight_since).toBe(first?.in_flight_since);
  });

  it('scheduleRetry sets next_retry_at and increments attempt_count', () => {
    markTurnInFlight('slack_main', '', 'msg_1');
    scheduleRetry(
      'slack_main',
      '',
      '2026-05-08T01:00:00Z',
      1,
      'network',
      'fetch failed',
    );
    const row = getRecoveryStateForTurn('slack_main', '');
    expect(row?.next_retry_at).toBe('2026-05-08T01:00:00Z');
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error_type).toBe('network');
    expect(row?.last_error_details).toBe('fetch failed');
  });

  it('clearRecoveryState wipes recovery columns but keeps the row', () => {
    markTurnInFlight('slack_main', '', 'msg_1');
    scheduleRetry('slack_main', '', '2026-05-08T01:00:00Z', 1, 'network', 'x');
    clearRecoveryState('slack_main', '');
    const row = getRecoveryStateForTurn('slack_main', '');
    expect(row?.in_flight_since).toBeNull();
    expect(row?.next_retry_at).toBeNull();
    expect(row?.attempt_count).toBe(0);
    expect(row?.last_error_type).toBeNull();
    expect(row?.pending_since_message_id).toBeNull();
  });

  it('getDueRecoveries returns rows where next_retry_at <= now', () => {
    markTurnInFlight('slack_main', '', 'msg_1');
    scheduleRetry('slack_main', '', '2026-05-08T00:00:00Z', 1, 'network', 'x');

    markTurnInFlight('telegram_main', '', 'msg_2');
    scheduleRetry(
      'telegram_main',
      '',
      '2099-01-01T00:00:00Z',
      1,
      'network',
      'x',
    );

    const due = getDueRecoveries(new Date('2026-05-08T00:00:30Z'));
    expect(due.map((r) => r.group_folder)).toContain('slack_main');
    expect(due.map((r) => r.group_folder)).not.toContain('telegram_main');
  });

  it('getDueRecoveries ordered by in_flight_since ASC', async () => {
    markTurnInFlight('a_first', '', 'm1');
    // Slight delay so timestamps differ
    await new Promise((r) => setTimeout(r, 10));
    markTurnInFlight('b_second', '', 'm2');
    scheduleRetry('a_first', '', '2026-05-08T00:00:00Z', 1, 'network', 'x');
    scheduleRetry('b_second', '', '2026-05-08T00:00:00Z', 1, 'network', 'x');
    const due = getDueRecoveries(new Date('2026-05-08T00:00:30Z'));
    expect(due[0].group_folder).toBe('a_first');
    expect(due[1].group_folder).toBe('b_second');
  });

  it('getAllInFlight returns only rows with in_flight_since set', () => {
    markTurnInFlight('alpha', '', 'm1');
    markTurnInFlight('beta', '', 'm2');
    clearRecoveryState('beta', '');
    const rows = getAllInFlight();
    expect(rows.map((r) => r.group_folder)).toEqual(['alpha']);
  });

  it('resetStaleRecoveryLocks pushes future next_retry_at to now', () => {
    markTurnInFlight('alpha', '', 'm1');
    scheduleRetry('alpha', '', '2099-01-01T00:00:00Z', 1, 'network', 'x');
    const changed = resetStaleRecoveryLocks(new Date('2026-05-08T00:00:00Z'));
    expect(changed).toBe(1);
    const row = getRecoveryStateForTurn('alpha', '');
    expect(row?.next_retry_at).toBe('2026-05-08T00:00:00.000Z');
  });

  it('per-thread isolation: different threads in same group are independent', () => {
    markTurnInFlight('slack_main', 'thread_a', 'msg_in_a');
    markTurnInFlight('slack_main', 'thread_b', 'msg_in_b');
    const a = getRecoveryStateForTurn('slack_main', 'thread_a');
    const b = getRecoveryStateForTurn('slack_main', 'thread_b');
    expect(a?.pending_since_message_id).toBe('msg_in_a');
    expect(b?.pending_since_message_id).toBe('msg_in_b');
    clearRecoveryState('slack_main', 'thread_a');
    expect(getRecoveryStateForTurn('slack_main', 'thread_a')?.in_flight_since).toBeNull();
    expect(getRecoveryStateForTurn('slack_main', 'thread_b')?.in_flight_since).not.toBeNull();
  });
});
