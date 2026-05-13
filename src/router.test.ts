import { describe, it, expect } from 'vitest';

import { formatMessages } from './router.js';
import type { NewMessage } from './types.js';

const TZ = 'UTC';

function msg(
  id: string,
  ts: string,
  content: string,
  threadId?: string,
): NewMessage {
  return {
    id,
    chat_jid: 'slack:CTEST',
    sender: 'U1',
    sender_name: 'Alice',
    content,
    timestamp: ts,
    is_from_me: false,
    is_bot_message: false,
    thread_id: threadId,
  };
}

describe('formatMessages — context attributes', () => {
  const M1 = msg('m-1', '2026-04-30T00:00:01.000Z', 'hello', 't-1');
  const M2 = msg('m-2', '2026-04-30T00:00:02.000Z', 'world', 't-1');

  it('emits mode=thread injection=full truncated=false on first turn', () => {
    const out = formatMessages([M1, M2], TZ, {
      context: {
        mode: 'thread',
        threadId: 't-1',
        injection: 'full',
        truncated: false,
        totalThreadMessages: 2,
        shown: 2,
      },
    });
    expect(out).toContain('mode="thread"');
    expect(out).toContain('thread_id="t-1"');
    expect(out).toContain('injection="full"');
    expect(out).toContain('truncated="false"');
    expect(out).toContain('total_thread_messages="2"');
    expect(out).toContain('shown="2"');
    expect(out).not.toContain('since=');
  });

  it('emits injection=delta with since on subsequent turns', () => {
    const out = formatMessages([M2], TZ, {
      context: {
        mode: 'thread',
        threadId: 't-1',
        injection: 'delta',
        truncated: false,
        totalThreadMessages: 12,
        shown: 1,
        since: '2026-04-30T00:00:01.000Z',
      },
    });
    expect(out).toContain('injection="delta"');
    expect(out).toContain('since="2026-04-30T00:00:01.000Z"');
    expect(out).toContain('total_thread_messages="12"');
    expect(out).toContain('shown="1"');
  });

  it('emits truncated=true when full injection hit the cap', () => {
    const out = formatMessages([M1, M2], TZ, {
      context: {
        mode: 'thread',
        threadId: 't-1',
        injection: 'full',
        truncated: true,
        totalThreadMessages: 600,
        shown: 2,
      },
    });
    expect(out).toContain('truncated="true"');
    expect(out).toContain('total_thread_messages="600"');
  });

  it('emits mode=root with channel_window for non-thread triggers', () => {
    const out = formatMessages([M1, M2], TZ, {
      context: {
        mode: 'root',
        channelWindow: 10,
        shown: 2,
      },
    });
    expect(out).toContain('mode="root"');
    expect(out).toContain('channel_window="10"');
    expect(out).not.toContain('thread_id=');
    expect(out).not.toContain('injection=');
  });

  it('root mode delta turn carries since but never injection', () => {
    // PR 11: root mode never emits `injection`. Thread mode's
    // `injection="full"` means "exhaustive thread"; using the same word
    // for root would imply "exhaustive channel history" — false. Root
    // <messages> is always a bounded window. The orchestrator passes
    // `since` to flag delta turns; the renderer omits any injection
    // attribute even if accidentally set in this case.
    const out = formatMessages([M2], TZ, {
      context: {
        mode: 'root',
        channelWindow: 10,
        shown: 1,
        since: '2026-04-30T00:00:00.000Z',
      },
    });
    expect(out).toContain('mode="root"');
    expect(out).toContain('since="2026-04-30T00:00:00.000Z"');
    expect(out).not.toContain('injection=');
  });

  it('omits all attributes (legacy) when no context provided', () => {
    const out = formatMessages([M1], TZ);
    expect(out).toContain('<context timezone="UTC" />');
    expect(out).not.toContain('mode=');
    expect(out).not.toContain('injection=');
  });

  it('escapes thread_id and since values in attributes', () => {
    const out = formatMessages([M1], TZ, {
      context: {
        mode: 'thread',
        threadId: 'a"b<c',
        injection: 'delta',
        since: '2026-04-30T00:00:00.000Z',
        shown: 1,
      },
    });
    // Verify the malicious thread_id can't break out of the attribute.
    expect(out).toContain('thread_id="a&quot;b&lt;c"');
    expect(out).not.toContain('thread_id="a"b<c"');
  });
});
