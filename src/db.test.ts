import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  clearSessionLastSeen,
  createTask,
  deleteSession,
  deleteStoredMessage,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRootMessagesSince,
  getSessionLastSeen,
  getTaskById,
  getThreadMessages,
  getThreadMessagesSince,
  setRegisteredGroup,
  setSession,
  setSessionLastSeen,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Per-thread delta injection (PR 5)
// ---------------------------------------------------------------------
//
// Goal: across N successive turns in the same thread, the orchestrator must
// not re-inject the same message twice. Turn 1 = full thread; turns 2..N =
// only what is strictly newer than the cursor advanced after turn N-1.
// This proves the cumulative payload is O(thread_size), not O(thread_size *
// turn_count).

describe('per-thread delta injection (PR 5)', () => {
  const CHAT = 'slack:CDELTA';
  const FOLDER = 'slack_delta';
  // Slack semantics: thread_id is the parent message's ts. The parent row
  // has id == thread_id; replies share that thread_id, but their own ids
  // differ. We model that here so the queries work the same as in prod.
  const PARENT_ID = '1700000000.000001';
  const BOT = 'TestBot';

  function ts(secondsFromBase: number): string {
    return new Date(1777680000000 + secondsFromBase * 1000).toISOString();
  }

  function parentMsg(secondsFromBase: number, content: string) {
    storeMessage({
      id: PARENT_ID,
      chat_jid: CHAT,
      sender: 'U1',
      sender_name: 'Alice',
      content,
      timestamp: ts(secondsFromBase),
      is_from_me: false,
      is_bot_message: false,
      thread_id: PARENT_ID,
    });
  }

  function userReply(
    idSuffix: string,
    secondsFromBase: number,
    content: string,
  ) {
    storeMessage({
      id: `u-${idSuffix}`,
      chat_jid: CHAT,
      sender: 'U1',
      sender_name: 'Alice',
      content,
      timestamp: ts(secondsFromBase),
      is_from_me: false,
      is_bot_message: false,
      thread_id: PARENT_ID,
    });
  }

  function botReply(
    idSuffix: string,
    secondsFromBase: number,
    content: string,
  ) {
    storeMessage({
      id: `b-${idSuffix}`,
      chat_jid: CHAT,
      sender: 'BOT',
      sender_name: BOT,
      content,
      timestamp: ts(secondsFromBase),
      is_from_me: true,
      is_bot_message: true,
      thread_id: PARENT_ID,
    });
  }

  it('first turn returns full thread, advances cursor', () => {
    storeChatMetadata(CHAT, ts(0));
    parentMsg(0, 'project link: foo');
    for (let i = 1; i <= 5; i++) userReply(String(i), i, `reply ${i}`);

    const turn1 = getThreadMessages(CHAT, PARENT_ID, BOT);
    expect(turn1.messages.length).toBe(6);
    expect(turn1.truncated).toBe(false);
    expect(turn1.messages[0].id).toBe(PARENT_ID);
    expect(turn1.messages[5].id).toBe('u-5');

    const latest = turn1.messages[turn1.messages.length - 1].timestamp;
    setSessionLastSeen(FOLDER, PARENT_ID, latest);

    expect(getSessionLastSeen(FOLDER, PARENT_ID)).toBe(ts(5));
  });

  it('subsequent turns inject only the delta — no message id repeats', () => {
    storeChatMetadata(CHAT, ts(0));
    parentMsg(0, 'project link: foo');
    for (let i = 1; i <= 5; i++) userReply(String(i), i, `reply ${i}`);

    // --- TURN 1 ---
    const turn1 = getThreadMessages(CHAT, PARENT_ID, BOT);
    setSessionLastSeen(
      FOLDER,
      PARENT_ID,
      turn1.messages[turn1.messages.length - 1].timestamp,
    );

    botReply('1', 6, 'understood');
    userReply('6', 7, 'follow-up');
    userReply('7', 8, 'one more thing');

    // --- TURN 2 ---
    const cursor2 = getSessionLastSeen(FOLDER, PARENT_ID);
    const turn2 = getThreadMessagesSince(CHAT, PARENT_ID, cursor2, BOT);
    setSessionLastSeen(
      FOLDER,
      PARENT_ID,
      turn2.messages[turn2.messages.length - 1].timestamp,
    );
    expect(turn2.messages.map((m) => m.id)).toEqual(['b-1', 'u-6', 'u-7']);

    botReply('2', 9, 'noted');
    userReply('8', 10, 'and this');

    // --- TURN 3 ---
    const cursor3 = getSessionLastSeen(FOLDER, PARENT_ID);
    const turn3 = getThreadMessagesSince(CHAT, PARENT_ID, cursor3, BOT);
    setSessionLastSeen(
      FOLDER,
      PARENT_ID,
      turn3.messages[turn3.messages.length - 1].timestamp,
    );
    expect(turn3.messages.map((m) => m.id)).toEqual(['b-2', 'u-8']);

    // --- NO DUPLICATION ACROSS TURNS ---
    const allIdsConcat = [
      ...turn1.messages.map((m) => m.id),
      ...turn2.messages.map((m) => m.id),
      ...turn3.messages.map((m) => m.id),
    ];
    const uniqueIds = new Set(allIdsConcat);
    expect(uniqueIds.size).toBe(allIdsConcat.length);

    // --- CUMULATIVE PAYLOAD == THREAD SIZE ---
    // 6 (turn 1: parent + 5 replies) + 3 (turn 2: 1 bot + 2 user)
    // + 2 (turn 3: 1 bot + 1 user) = 11. Matches the full thread size.
    const everyThreadRow = getThreadMessages(CHAT, PARENT_ID, BOT);
    expect(allIdsConcat.length).toBe(everyThreadRow.messages.length);
  });

  it('empty cursor falls back to full-thread fetch', () => {
    storeChatMetadata(CHAT, ts(0));
    parentMsg(0, 'topic');
    for (let i = 1; i <= 3; i++) userReply(String(i), i, `r${i}`);

    const result = getThreadMessagesSince(CHAT, PARENT_ID, '', BOT);
    expect(result.messages.length).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('clearing the cursor restores full-thread injection on next turn', () => {
    storeChatMetadata(CHAT, ts(0));
    parentMsg(0, 'topic');
    for (let i = 1; i <= 3; i++) userReply(String(i), i, `r${i}`);

    const turn1 = getThreadMessages(CHAT, PARENT_ID, BOT);
    setSessionLastSeen(
      FOLDER,
      PARENT_ID,
      turn1.messages[turn1.messages.length - 1].timestamp,
    );
    expect(getSessionLastSeen(FOLDER, PARENT_ID)).toBe(ts(3));

    clearSessionLastSeen(FOLDER, PARENT_ID);
    expect(getSessionLastSeen(FOLDER, PARENT_ID)).toBe('');

    userReply('4', 4, 'new');
    const turn2 = getThreadMessagesSince(
      CHAT,
      PARENT_ID,
      getSessionLastSeen(FOLDER, PARENT_ID),
      BOT,
    );
    expect(turn2.messages.length).toBe(5);
    expect(turn2.messages[0].id).toBe(PARENT_ID);
  });

  it('setSession preserves last_seen_ts across SDK session id changes', () => {
    storeChatMetadata(CHAT, ts(0));
    parentMsg(0, 'topic');
    setSessionLastSeen(FOLDER, PARENT_ID, ts(0));

    // SDK rotates session id mid-conversation. setSession must NOT clobber
    // the cursor — INSERT OR REPLACE would, the new ON CONFLICT UPDATE
    // doesn't.
    setSession(FOLDER, PARENT_ID, 'new-sdk-session-id');

    expect(getSessionLastSeen(FOLDER, PARENT_ID)).toBe(ts(0));
  });
});

// ---------------------------------------------------------------------
// Root-mode delta injection (PR 10)
// ---------------------------------------------------------------------
//
// Symmetric to PR 5's per-thread cursor: root mode (no thread context —
// Telegram DMs, basic groups) reuses last_seen_ts on the (folder, '')
// sessions row. First turn injects last-N channel window; subsequent
// turns inject only the delta. Session drop clears the cursor so the
// next turn re-injects the full window — without this, non-threading
// channels permanently end up with shown=1 after any session rotation.

describe('root-mode delta injection (PR 10)', () => {
  const CHAT = 'tg:DELTA';
  const FOLDER = 'telegram_delta';

  function ts(secondsFromBase: number): string {
    return new Date(1777680000000 + secondsFromBase * 1000).toISOString();
  }

  function userRoot(
    idSuffix: string,
    secondsFromBase: number,
    content: string,
  ) {
    storeMessage({
      id: `u-${idSuffix}`,
      chat_jid: CHAT,
      sender: 'U1',
      sender_name: 'Alice',
      content,
      timestamp: ts(secondsFromBase),
      is_from_me: false,
      is_bot_message: false,
      // Telegram non-topic: thread_id is null on every message.
      thread_id: undefined,
    });
  }

  it('first turn returns last-N root messages (full window)', () => {
    storeChatMetadata(CHAT, ts(0));
    for (let i = 1; i <= 5; i++) userRoot(String(i), i, `msg ${i}`);

    // Empty cursor → returns last N (all 5 in this case, well under cap).
    const turn1 = getRootMessagesSince(CHAT, '', 'TestBot', 10);
    expect(turn1.length).toBe(5);
    expect(turn1[0].id).toBe('u-1');
    expect(turn1[4].id).toBe('u-5');
  });

  it('subsequent turns return only delta — no message id repeats', () => {
    storeChatMetadata(CHAT, ts(0));
    for (let i = 1; i <= 5; i++) userRoot(String(i), i, `msg ${i}`);

    // Turn 1: full window, advance cursor.
    const turn1 = getRootMessagesSince(CHAT, '', 'TestBot', 10);
    setSessionLastSeen(FOLDER, '', turn1[turn1.length - 1].timestamp);

    // Two new messages arrive.
    userRoot('6', 6, 'msg 6');
    userRoot('7', 7, 'msg 7');

    // Turn 2: only delta.
    const cursor2 = getSessionLastSeen(FOLDER, '');
    const turn2 = getRootMessagesSince(CHAT, cursor2, 'TestBot', 10);
    expect(turn2.map((m) => m.id)).toEqual(['u-6', 'u-7']);
    setSessionLastSeen(FOLDER, '', turn2[turn2.length - 1].timestamp);

    // Turn 3: another single message.
    userRoot('8', 8, 'msg 8');
    const cursor3 = getSessionLastSeen(FOLDER, '');
    const turn3 = getRootMessagesSince(CHAT, cursor3, 'TestBot', 10);
    expect(turn3.map((m) => m.id)).toEqual(['u-8']);

    // No message id repeats across turns.
    const all = [...turn1, ...turn2, ...turn3].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('deleteSession clears the root cursor — full window on next turn', () => {
    storeChatMetadata(CHAT, ts(0));
    for (let i = 1; i <= 4; i++) userRoot(String(i), i, `msg ${i}`);

    // Turn 1: full window, cursor set.
    const turn1 = getRootMessagesSince(CHAT, '', 'TestBot', 10);
    setSession(FOLDER, '', 'sdk-session-A');
    setSessionLastSeen(FOLDER, '', turn1[turn1.length - 1].timestamp);
    expect(getSessionLastSeen(FOLDER, '')).toBe(ts(4));

    // Simulate session drop (rotateIfPoisoned, thrash circuit-breaker, or
    // stale-session detection). Removes the row entirely — cursor goes too.
    deleteSession(FOLDER, '');
    expect(getSessionLastSeen(FOLDER, '')).toBe('');

    // New message arrives.
    userRoot('5', 5, 'msg 5');

    // Turn 2 after the drop: empty cursor → re-injects the full window
    // (last N), not just the delta. This is the recovery path that thread
    // mode already had via PR 5; root mode now has it too.
    const turn2 = getRootMessagesSince(
      CHAT,
      getSessionLastSeen(FOLDER, ''),
      'TestBot',
      10,
    );
    expect(turn2.length).toBe(5);
    expect(turn2[0].id).toBe('u-1');
    expect(turn2[4].id).toBe('u-5');
  });
});

// ---------------------------------------------------------------------
// deleteStoredMessage (PR 14 — used by delete_message IPC)
// ---------------------------------------------------------------------

describe('deleteStoredMessage', () => {
  it('removes a message scoped to (chat_jid, id) and returns 1', () => {
    storeChatMetadata('slack:CDEL', '2026-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'slack:CDEL',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2026-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'msg-2',
      chat_jid: 'slack:CDEL',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'second',
      timestamp: '2026-01-01T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(deleteStoredMessage('slack:CDEL', 'msg-1')).toBe(1);

    const remaining = getMessagesSince('slack:CDEL', '', 'TestBot');
    expect(remaining.map((m) => m.id)).toEqual(['msg-2']);
  });

  it('returns 0 if no row matches', () => {
    storeChatMetadata('slack:CDEL', '2026-01-01T00:00:00.000Z');
    expect(deleteStoredMessage('slack:CDEL', 'never-existed')).toBe(0);
  });

  it('does not delete a same-id row from a different chat_jid', () => {
    storeChatMetadata('slack:A', '2026-01-01T00:00:00.000Z');
    storeChatMetadata('slack:B', '2026-01-01T00:00:00.000Z');
    storeMessage({
      id: 'shared-id',
      chat_jid: 'slack:A',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'in A',
      timestamp: '2026-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'shared-id',
      chat_jid: 'slack:B',
      sender: 'U2',
      sender_name: 'Bob',
      content: 'in B',
      timestamp: '2026-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(deleteStoredMessage('slack:A', 'shared-id')).toBe(1);

    expect(getMessagesSince('slack:A', '', 'TestBot')).toEqual([]);
    const inB = getMessagesSince('slack:B', '', 'TestBot');
    expect(inB).toHaveLength(1);
    expect(inB[0].content).toBe('in B');
  });
});
