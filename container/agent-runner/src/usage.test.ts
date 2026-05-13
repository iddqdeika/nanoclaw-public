import { describe, it, expect } from 'vitest';

import {
  accumulateMessageUsage,
  emptyDedupe,
  emptyUsage,
} from './usage.js';

// The bug this test guards against:
// the SDK emits two `assistant` events for one streaming response — first
// the thinking phase, then the final text — both carrying the same
// message.id. Each event has a `usage.output_tokens` field, but the field
// is NOT additive across the two events. Naively summing produces
// `output_tokens=14` for a response whose JSONL transcript shows 1475.
// `accumulateMessageUsage` dedupes by message id and takes the MAX seen
// per message rather than summing every emission.

describe('accumulateMessageUsage — message.id dedupe', () => {
  it('takes max output_tokens when SDK emits cumulative values', () => {
    // Real-world shape: thinking event then final event.
    // First emission: partial output (7 thinking tokens).
    // Second emission: cumulative final (1475 tokens for thinking + text).
    const u = emptyUsage();
    const d = emptyDedupe();

    accumulateMessageUsage(u, d, {
      messageId: 'msg_01HVaQ26cP',
      model: 'claude-sonnet-4-6',
      input_tokens: 3,
      cache_creation_input_tokens: 78462,
      cache_read_input_tokens: 0,
      output_tokens: 7,
    });
    accumulateMessageUsage(u, d, {
      messageId: 'msg_01HVaQ26cP',
      model: 'claude-sonnet-4-6',
      input_tokens: 3,
      cache_creation_input_tokens: 78462,
      cache_read_input_tokens: 0,
      output_tokens: 1475,
    });

    expect(u.output_tokens).toBe(1475);
    // Constants counted once — not double-counted.
    expect(u.input_tokens).toBe(3);
    expect(u.cache_creation_tokens).toBe(78462);
    expect(u.cache_read_tokens).toBe(0);
    expect(u.api_call_count).toBe(1);
    expect(u.max_context_tokens).toBe(78465);
  });

  it('handles SDK emitting same partial twice (no cumulative final)', () => {
    // Pathological case: SDK emits the same partial usage on both
    // emissions (which is what we observed in production logs producing
    // out=14 from two events of out=7 each).
    const u = emptyUsage();
    const d = emptyDedupe();

    accumulateMessageUsage(u, d, {
      messageId: 'msg_X',
      output_tokens: 7,
      input_tokens: 6,
    });
    accumulateMessageUsage(u, d, {
      messageId: 'msg_X',
      output_tokens: 7,
      input_tokens: 6,
    });

    expect(u.output_tokens).toBe(7);
    expect(u.input_tokens).toBe(6);
    expect(u.api_call_count).toBe(1);
  });

  it('sums output_tokens across DIFFERENT message ids (multi-API-call turn)', () => {
    // Real-world: a turn with tool calls fires multiple API calls, each
    // produces its own message id with its own usage.
    const u = emptyUsage();
    const d = emptyDedupe();

    // Call 1: thinking + final, both with msg id A.
    accumulateMessageUsage(u, d, {
      messageId: 'msg_A',
      output_tokens: 5,
      input_tokens: 3,
      cache_creation_input_tokens: 100,
    });
    accumulateMessageUsage(u, d, {
      messageId: 'msg_A',
      output_tokens: 200,
      input_tokens: 3,
      cache_creation_input_tokens: 100,
    });
    // Call 2: msg id B.
    accumulateMessageUsage(u, d, {
      messageId: 'msg_B',
      output_tokens: 350,
      input_tokens: 1,
      cache_read_input_tokens: 50,
    });

    expect(u.output_tokens).toBe(550); // 200 + 350
    expect(u.input_tokens).toBe(4);    // 3 + 1
    expect(u.cache_creation_tokens).toBe(100);
    expect(u.cache_read_tokens).toBe(50);
    expect(u.api_call_count).toBe(2);
  });

  it('reset between turns isolates accounting', () => {
    const u1 = emptyUsage();
    const d1 = emptyDedupe();
    accumulateMessageUsage(u1, d1, {
      messageId: 'msg_X',
      output_tokens: 100,
      input_tokens: 5,
    });

    // New turn — fresh state.
    const u2 = emptyUsage();
    const d2 = emptyDedupe();
    accumulateMessageUsage(u2, d2, {
      messageId: 'msg_X', // same id from previous turn — that's expected
      output_tokens: 200,
      input_tokens: 5,
    });

    expect(u1.output_tokens).toBe(100);
    expect(u2.output_tokens).toBe(200); // not affected by previous turn
  });

  it('legacy fallback: no message id sums every event', () => {
    // Backwards-compatible path for the rare case message.id is missing.
    const u = emptyUsage();
    const d = emptyDedupe();

    accumulateMessageUsage(u, d, {
      output_tokens: 7,
      input_tokens: 3,
    });
    accumulateMessageUsage(u, d, {
      output_tokens: 1475,
      input_tokens: 3,
    });

    // Without a key to dedupe on, we sum (legacy behaviour).
    expect(u.output_tokens).toBe(1482);
    expect(u.input_tokens).toBe(6);
    expect(u.api_call_count).toBe(2);
  });

  it('tool_use blocks count once per message id (only on first emission)', () => {
    const u = emptyUsage();
    const d = emptyDedupe();

    // Emulate index.ts behaviour: the caller decides whether to pass
    // toolUseNames based on whether the message id has been seen yet.
    const evt1 = {
      messageId: 'msg_T',
      output_tokens: 50,
      toolUseNames:
        d.countedMessages.has('msg_T') ? [] : ['Bash', 'Read'],
    };
    accumulateMessageUsage(u, d, evt1);

    const evt2 = {
      messageId: 'msg_T',
      output_tokens: 200,
      toolUseNames:
        d.countedMessages.has('msg_T') ? [] : ['Bash', 'Read'],
    };
    accumulateMessageUsage(u, d, evt2);

    expect(u.tool_call_count).toBe(2);
    expect(u.tool_calls).toEqual({ Bash: 1, Read: 1 });
    // Output dedupe still works alongside.
    expect(u.output_tokens).toBe(200);
  });

  it('does not move output_tokens backwards when a smaller value arrives second', () => {
    // Defensive: if the SDK ever emits the partial AFTER the cumulative,
    // the running total should not shrink.
    const u = emptyUsage();
    const d = emptyDedupe();

    accumulateMessageUsage(u, d, {
      messageId: 'msg_X',
      output_tokens: 1475,
    });
    accumulateMessageUsage(u, d, {
      messageId: 'msg_X',
      output_tokens: 7, // smaller — should be ignored
    });

    expect(u.output_tokens).toBe(1475);
  });
});
