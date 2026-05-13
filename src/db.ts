import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      last_seen_ts TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, thread_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS turn_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      session_id TEXT,
      trigger_message_id TEXT,
      model TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      status TEXT,
      input_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      tool_calls_json TEXT,
      max_context_tokens INTEGER DEFAULT 0,
      avg_context_tokens INTEGER DEFAULT 0,
      api_call_count INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tm_group_time ON turn_metrics(group_folder, started_at);
    CREATE INDEX IF NOT EXISTS idx_tm_session ON turn_metrics(session_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add thread_id column — captured from the scheduling agent's current
  // thread context. When the task fires, container is started with this
  // thread so replies go back to the originating thread by default.
  // Empty string / NULL = channel root.
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Per-API-call context stats on turn_metrics. Older rows will have 0s.
  try {
    database.exec(
      `ALTER TABLE turn_metrics ADD COLUMN max_context_tokens INTEGER DEFAULT 0`,
    );
    database.exec(
      `ALTER TABLE turn_metrics ADD COLUMN avg_context_tokens INTEGER DEFAULT 0`,
    );
    database.exec(
      `ALTER TABLE turn_metrics ADD COLUMN api_call_count INTEGER DEFAULT 0`,
    );
  } catch {
    /* columns already exist */
  }

  // retry_count: number of rollback-and-retry cycles that consumed tokens
  // before this turn produced a captured result. Each retry roughly
  // multiplies the cost of the original message, so this column lets the
  // /usage dashboard surface amplification-from-thrash separately.
  try {
    database.exec(
      `ALTER TABLE turn_metrics ADD COLUMN retry_count INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Backfill existing non-main groups as trusted (preserves current behavior)
  try {
    const rows = database
      .prepare(
        `SELECT jid, container_config FROM registered_groups WHERE is_main = 0`,
      )
      .all() as Array<{ jid: string; container_config: string | null }>;
    for (const row of rows) {
      const config = row.container_config
        ? JSON.parse(row.container_config)
        : {};
      if (config.trusted === undefined) {
        config.trusted = true;
        database
          .prepare(
            `UPDATE registered_groups SET container_config = ? WHERE jid = ?`,
          )
          .run(JSON.stringify(config), row.jid);
      }
    }
  } catch {
    /* already migrated or no groups yet */
  }

  // Add last_seen_ts column for delta-only thread injection (PR 5).
  // Tracks the timestamp of the most recent message we've already injected
  // into the prompt for this (group_folder, thread_id) — subsequent turns
  // pull only messages newer than this cursor instead of re-sending the
  // whole thread.
  try {
    database.exec(
      `ALTER TABLE sessions ADD COLUMN last_seen_ts TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    /* column already exists */
  }

  // Sessions migration: extend PK from (group_folder) to
  // (group_folder, thread_id) so per-thread sessions don't collide.
  // SQLite treats NULLs as distinct in composite PKs, so we use empty
  // string '' as the "no thread / root session" sentinel.
  // Idempotent — only runs when the legacy single-column table is detected.
  try {
    const cols = database
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as Array<{ name: string }>;
    const hasThreadId = cols.some((c) => c.name === 'thread_id');
    if (!hasThreadId && cols.length > 0) {
      database.exec(`
        CREATE TABLE sessions_v2 (
          group_folder TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL,
          PRIMARY KEY (group_folder, thread_id)
        );
        INSERT INTO sessions_v2 (group_folder, thread_id, session_id)
          SELECT group_folder, '', session_id FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
      `);
      logger.info(
        'Migrated sessions table: (group_folder) → (group_folder, thread_id)',
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'sessions per-thread migration failed',
    );
  }

  // Recovery state columns on sessions. Encode per-(group, thread) retry
  // state so background sweep + boot hook can resume failed turns.
  // See rules/admin/recovery.md (after install) and docs/RECOVERY-TESTING.md.
  for (const col of [
    'in_flight_since TEXT',
    'next_retry_at TEXT',
    'attempt_count INTEGER DEFAULT 0',
    'last_error_type TEXT',
    'last_error_details TEXT',
    'pending_since_message_id TEXT',
  ]) {
    try {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // Index for sweep loop: query rows where next_retry_at <= now efficiently.
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_next_retry ON sessions(next_retry_at) WHERE next_retry_at IS NOT NULL`,
    );
  } catch {
    /* index already exists or partial-index syntax not supported on old SQLite */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
/**
 * Delete a single message from messages.db. Used by delete_message IPC
 * after the channel-side delete (Slack chat.delete) succeeds.
 * Returns the number of rows affected (0 if not present).
 */
export function deleteStoredMessage(chatJid: string, id: string): number {
  const r = db
    .prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?')
    .run(chatJid, id);
  return r.changes;
}

export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
    msg.thread_id ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * Same as getMessagesSince but limited to root-level (non-thread-reply) messages.
 * "Root" = thread_id IS NULL (legacy / non-threading channels) OR thread_id = id
 * (Slack/Telegram top-level messages, where the message starts its own thread).
 *
 * Used for top-level triggers so the prompt isn't polluted with thread chatter
 * from unrelated threads in the same channel.
 */
export function getRootMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Bot messages ARE included so the agent can see its own prior replies.
  // Legacy bot stragglers (is_bot_message=0 + 'X:' content prefix) stay out
  // — that pattern predates the is_bot_message column and is junk for the
  // modern prompt.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND (thread_id IS NULL OR thread_id = id)
        AND NOT (is_bot_message = 0 AND content LIKE ?)
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * Fetch every message belonging to a thread (parent + replies), chronological.
 *
 * Bypasses MAX_MESSAGES_PER_PROMPT — threads are bounded by their own size,
 * not by recency. Caps via maxMessages / maxBytes act as safety nets only;
 * typical threads (a few KB) never hit them. When a cap is hit, the parent
 * is preserved and the most recent replies are kept; `truncated` reports it.
 */
export function getThreadMessages(
  chatJid: string,
  threadId: string,
  botPrefix: string,
  opts: { maxMessages?: number; maxBytes?: number } = {},
): { messages: NewMessage[]; truncated: boolean; totalCount: number } {
  const maxMessages = opts.maxMessages ?? 500;
  const maxBytes = opts.maxBytes ?? 200_000;

  // Bot messages ARE included so the agent can see its own prior replies in
  // the thread. With per-thread sessions, the SDK transcript is fresh on
  // the first turn for each thread — without bot messages here the agent
  // would not see what it itself said earlier in the same thread.
  // Legacy bot stragglers (is_bot_message=0 + 'X:' content prefix, predates
  // the is_bot_message column) stay out — they're junk for the prompt.
  const all = db
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
           reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
    FROM messages
    WHERE chat_jid = ? AND (thread_id = ? OR id = ?)
      AND NOT (is_bot_message = 0 AND content LIKE ?)
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp ASC
  `,
    )
    .all(chatJid, threadId, threadId, `${botPrefix}:%`) as NewMessage[];

  const totalCount = all.length;
  const totalBytes = all.reduce((s, m) => s + (m.content?.length ?? 0), 0);

  if (totalCount <= maxMessages && totalBytes <= maxBytes) {
    return { messages: all, truncated: false, totalCount };
  }

  // Cap hit: keep parent (id === threadId) + walk replies newest → oldest
  // until either cap; reverse so chronological order is preserved.
  const parent = all.find((m) => m.id === threadId) ?? null;
  const replies = all.filter((m) => m.id !== threadId);

  const tail: NewMessage[] = [];
  let usedBytes = parent?.content?.length ?? 0;
  let count = parent ? 1 : 0;

  for (let i = replies.length - 1; i >= 0; i--) {
    if (count >= maxMessages) break;
    const sz = replies[i].content?.length ?? 0;
    if (usedBytes + sz > maxBytes) break;
    tail.push(replies[i]);
    usedBytes += sz;
    count++;
  }
  tail.reverse();

  const messages = parent ? [parent, ...tail] : tail;
  return { messages, truncated: true, totalCount };
}

/**
 * Delta-only variant of getThreadMessages: returns thread messages strictly
 * newer than `sinceTimestamp`. Used after the first turn for a given
 * (chat, thread) pair so subsequent turns send only what's new.
 *
 * - sinceTimestamp empty → behaves like getThreadMessages (full thread).
 * - sinceTimestamp set → only messages with timestamp > sinceTimestamp.
 *
 * Same content filtering rules as getThreadMessages: bot messages
 * included (PR 4), legacy 'X:' prefix stragglers excluded.
 *
 * The cap semantics match getThreadMessages but operate on the delta only:
 * if the delta itself ever exceeds the cap (huge backlog of new messages),
 * the most recent slice is kept and `truncated` is set.
 */
export function getThreadMessagesSince(
  chatJid: string,
  threadId: string,
  sinceTimestamp: string,
  botPrefix: string,
  opts: { maxMessages?: number; maxBytes?: number } = {},
): { messages: NewMessage[]; truncated: boolean; totalCount: number } {
  if (!sinceTimestamp) {
    return getThreadMessages(chatJid, threadId, botPrefix, opts);
  }
  const maxMessages = opts.maxMessages ?? 500;
  const maxBytes = opts.maxBytes ?? 200_000;

  const all = db
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
           reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
    FROM messages
    WHERE chat_jid = ? AND (thread_id = ? OR id = ?)
      AND timestamp > ?
      AND NOT (is_bot_message = 0 AND content LIKE ?)
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp ASC
  `,
    )
    .all(
      chatJid,
      threadId,
      threadId,
      sinceTimestamp,
      `${botPrefix}:%`,
    ) as NewMessage[];

  const totalCount = all.length;
  const totalBytes = all.reduce((s, m) => s + (m.content?.length ?? 0), 0);

  if (totalCount <= maxMessages && totalBytes <= maxBytes) {
    return { messages: all, truncated: false, totalCount };
  }

  // Cap on the delta itself — keep most recent within cap.
  const tail: NewMessage[] = [];
  let usedBytes = 0;
  let count = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (count >= maxMessages) break;
    const sz = all[i].content?.length ?? 0;
    if (usedBytes + sz > maxBytes) break;
    tail.push(all[i]);
    usedBytes += sz;
    count++;
  }
  tail.reverse();
  return { messages: tail, truncated: true, totalCount };
}

// --- History tools (channel-scoped, used by the four MCP tools) ---

/**
 * List recent messages for a channel.
 * scope='root' returns only top-level (non-thread-reply) messages —
 * useful when the agent wants channel-level context without thread chatter.
 * scope='all' returns everything in time order.
 */
export function listRecentMessages(
  chatJid: string,
  opts: { limit?: number; scope?: 'root' | 'all'; since?: string } = {},
): NewMessage[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const scope = opts.scope ?? 'root';
  const since = opts.since ?? '';

  const scopeClause =
    scope === 'root' ? `AND (thread_id IS NULL OR thread_id = id)` : '';

  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        ${scopeClause}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp ASC
  `;
  return db.prepare(sql).all(chatJid, since, limit) as NewMessage[];
}

export interface ThreadSummary {
  thread_id: string;
  parent_snippet: string | null;
  parent_sender: string | null;
  reply_count: number;
  last_activity: string;
  participant_count: number;
}

/**
 * List recent threads for a channel — one row per distinct thread_id, with
 * parent message snippet, reply count, and last activity. On non-threading
 * channels (no thread_id ever set) this returns an empty array.
 *
 * "Thread" = a thread_id with at least one reply (i.e. excluded are root
 * messages where thread_id = id but no replies exist — those aren't really
 * threads, just channel root messages).
 */
export function listThreads(
  chatJid: string,
  opts: { limit?: number; since?: string } = {},
): ThreadSummary[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const since = opts.since ?? '';

  // Group rows by thread_id; require at least one reply (a row whose id
  // differs from thread_id) to count as a real thread. Order by most
  // recent activity within the thread.
  const rows = db
    .prepare(
      `
    SELECT thread_id,
           COUNT(*) - 1 as reply_count,
           MAX(timestamp) as last_activity,
           COUNT(DISTINCT sender) as participant_count
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND thread_id IS NOT NULL AND thread_id != ''
      AND content != '' AND content IS NOT NULL
    GROUP BY thread_id
    HAVING COUNT(CASE WHEN id != thread_id THEN 1 END) > 0
    ORDER BY last_activity DESC
    LIMIT ?
  `,
    )
    .all(chatJid, since, limit) as Array<{
    thread_id: string;
    reply_count: number;
    last_activity: string;
    participant_count: number;
  }>;

  if (rows.length === 0) return [];

  // Fetch parent message snippets in one go.
  const threadIds = rows.map((r) => r.thread_id);
  const placeholders = threadIds.map(() => '?').join(',');
  const parents = db
    .prepare(
      `
    SELECT id, sender_name, substr(content, 1, 200) as snippet
    FROM messages
    WHERE chat_jid = ? AND id IN (${placeholders})
  `,
    )
    .all(chatJid, ...threadIds) as Array<{
    id: string;
    sender_name: string;
    snippet: string;
  }>;
  const parentByThread = new Map<
    string,
    { sender_name: string; snippet: string }
  >();
  for (const p of parents) {
    parentByThread.set(p.id, {
      sender_name: p.sender_name,
      snippet: p.snippet,
    });
  }

  return rows.map((r) => ({
    thread_id: r.thread_id,
    parent_snippet: parentByThread.get(r.thread_id)?.snippet ?? null,
    parent_sender: parentByThread.get(r.thread_id)?.sender_name ?? null,
    reply_count: r.reply_count,
    last_activity: r.last_activity,
    participant_count: r.participant_count,
  }));
}

export interface SearchHit {
  id: string;
  sender_name: string;
  timestamp: string;
  content: string;
  thread_id: string | null;
  is_from_me: number;
}

export interface SearchResult {
  // Flat list when grouping is off or when no threading exists.
  flat?: SearchHit[];
  // Grouped: one entry per thread (plus a `root` bucket for non-thread hits).
  threads?: Array<{
    thread_id: string;
    parent_snippet: string | null;
    hits: SearchHit[];
  }>;
  root?: SearchHit[];
  totalMatches: number;
}

/**
 * Plain LIKE-based message search scoped to a single channel.
 *
 * groupedByThread=true (Slack/Telegram-topic channels) returns matches
 * partitioned by thread so the agent can see hits in their thread context.
 * groupedByThread=false returns a flat list ordered by recency.
 */
export function searchMessages(
  chatJid: string,
  query: string,
  opts: {
    limit?: number;
    since?: string;
    sender?: string;
    groupedByThread?: boolean;
  } = {},
): SearchResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const since = opts.since ?? '';
  const senderFilter = opts.sender ? `%${opts.sender}%` : null;
  const grouped = opts.groupedByThread ?? true;
  const pattern = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

  const senderClause = senderFilter
    ? `AND (sender_name LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')`
    : '';

  const sql = `
    SELECT id, sender, sender_name, content, timestamp, is_from_me, thread_id
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND content LIKE ? ESCAPE '\\'
      AND content != '' AND content IS NOT NULL
      ${senderClause}
    ORDER BY timestamp DESC
    LIMIT ?
  `;

  const params: (string | number)[] = [chatJid, since, pattern];
  if (senderFilter) params.push(senderFilter, senderFilter);
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as SearchHit[];

  if (!grouped || rows.length === 0) {
    return { flat: rows, totalMatches: rows.length };
  }

  // Partition by thread_id. Slack root messages have thread_id === id but
  // count as root (no actual thread context). Treat them as root hits.
  const byThread = new Map<string, SearchHit[]>();
  const rootHits: SearchHit[] = [];
  for (const hit of rows) {
    if (hit.thread_id && hit.thread_id !== '' && hit.thread_id !== hit.id) {
      const arr = byThread.get(hit.thread_id) ?? [];
      arr.push(hit);
      byThread.set(hit.thread_id, arr);
    } else {
      rootHits.push(hit);
    }
  }

  // Pull parent snippets for the threads we hit.
  const threadIds = [...byThread.keys()];
  const parentSnippets = new Map<string, string | null>();
  if (threadIds.length > 0) {
    const placeholders = threadIds.map(() => '?').join(',');
    const parents = db
      .prepare(
        `SELECT id, substr(content, 1, 200) as snippet FROM messages
         WHERE chat_jid = ? AND id IN (${placeholders})`,
      )
      .all(chatJid, ...threadIds) as Array<{ id: string; snippet: string }>;
    for (const p of parents) parentSnippets.set(p.id, p.snippet);
  }

  // Order threads by their most-recent hit timestamp (descending).
  const threads = threadIds
    .map((tid) => ({
      thread_id: tid,
      parent_snippet: parentSnippets.get(tid) ?? null,
      hits: byThread
        .get(tid)!
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)),
    }))
    .sort((a, b) => {
      const at = a.hits[a.hits.length - 1].timestamp;
      const bt = b.hits[b.hits.length - 1].timestamp;
      return at < bt ? 1 : at > bt ? -1 : 0;
    });

  return {
    threads,
    root: rootHits,
    totalMatches: rows.length,
  };
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, thread_id, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.thread_id || null,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export interface TurnMetricsRow {
  group_folder: string;
  chat_jid: string;
  session_id: string | null;
  trigger_message_id: string | null;
  model: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: string;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  tool_call_count: number;
  tool_calls_json: string | null;
  max_context_tokens: number;
  avg_context_tokens: number;
  api_call_count: number;
  retry_count?: number;
}

export function writeTurnMetrics(row: TurnMetricsRow): void {
  const total =
    row.input_tokens + row.cache_creation_tokens + row.cache_read_tokens;
  db.prepare(
    `INSERT INTO turn_metrics (
      group_folder, chat_jid, session_id, trigger_message_id, model,
      started_at, ended_at, duration_ms, status,
      input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens,
      total_input_tokens, tool_call_count, tool_calls_json,
      max_context_tokens, avg_context_tokens, api_call_count, retry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.group_folder,
    row.chat_jid,
    row.session_id,
    row.trigger_message_id,
    row.model,
    row.started_at,
    row.ended_at,
    row.duration_ms,
    row.status,
    row.input_tokens,
    row.cache_creation_tokens,
    row.cache_read_tokens,
    row.output_tokens,
    total,
    row.tool_call_count,
    row.tool_calls_json,
    row.max_context_tokens,
    row.avg_context_tokens,
    row.api_call_count,
    row.retry_count ?? 0,
  );
}

export interface MetricsAggregation {
  group_folder: string | null;
  bucket: string | null;
  turns: number;
  sum_input_tokens: number;
  sum_cache_creation_tokens: number;
  sum_cache_read_tokens: number;
  sum_output_tokens: number;
  sum_total_input_tokens: number;
  avg_total_input_tokens: number;
  max_total_input_tokens: number;
  // Per-API-call context (the "real" context size sent to the model each call):
  peak_context_tokens: number; // the single biggest API call seen in the bucket
  avg_peak_context_tokens: number; // avg of each turn's max single-call context
  avg_avg_context_tokens: number; // avg of each turn's avg single-call context
  sum_tool_calls: number;
  avg_tool_calls: number;
  sum_api_calls: number;
  errors: number;
}

export interface QueryMetricsFilter {
  group_folder?: string;
  since?: string;
  until?: string;
  aggregate_by?: 'day' | 'session' | 'group' | 'none';
  limit?: number;
}

/**
 * Query turn_metrics with optional aggregation.
 * When aggregate_by is 'none', returns raw rows ordered newest-first.
 * Otherwise returns aggregated rows with bucket = day/session/group.
 */
export function queryTurnMetrics(
  filter: QueryMetricsFilter,
):
  | Array<TurnMetricsRow & { id: number; total_input_tokens: number }>
  | MetricsAggregation[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.group_folder) {
    conds.push('group_folder = ?');
    params.push(filter.group_folder);
  }
  if (filter.since) {
    conds.push('started_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    conds.push('started_at <= ?');
    params.push(filter.until);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000);

  if (!filter.aggregate_by || filter.aggregate_by === 'none') {
    return db
      .prepare(
        `SELECT * FROM turn_metrics ${where} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<
      TurnMetricsRow & { id: number; total_input_tokens: number }
    >;
  }

  const bucketExpr =
    filter.aggregate_by === 'day'
      ? `substr(started_at, 1, 10)`
      : filter.aggregate_by === 'session'
        ? `session_id`
        : `group_folder`;

  const sql = `
    SELECT
      group_folder,
      ${bucketExpr} AS bucket,
      COUNT(*) AS turns,
      SUM(input_tokens) AS sum_input_tokens,
      SUM(cache_creation_tokens) AS sum_cache_creation_tokens,
      SUM(cache_read_tokens) AS sum_cache_read_tokens,
      SUM(output_tokens) AS sum_output_tokens,
      SUM(total_input_tokens) AS sum_total_input_tokens,
      CAST(AVG(total_input_tokens) AS INTEGER) AS avg_total_input_tokens,
      MAX(total_input_tokens) AS max_total_input_tokens,
      MAX(max_context_tokens) AS peak_context_tokens,
      CAST(AVG(NULLIF(max_context_tokens, 0)) AS INTEGER) AS avg_peak_context_tokens,
      CAST(AVG(NULLIF(avg_context_tokens, 0)) AS INTEGER) AS avg_avg_context_tokens,
      SUM(tool_call_count) AS sum_tool_calls,
      CAST(AVG(tool_call_count) AS REAL) AS avg_tool_calls,
      SUM(api_call_count) AS sum_api_calls,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
    FROM turn_metrics
    ${where}
    GROUP BY group_folder, bucket
    ORDER BY bucket DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit) as MetricsAggregation[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---
//
// Sessions are keyed by (group_folder, thread_id). thread_id is the empty
// string '' for non-threaded contexts (root channel sessions, WhatsApp,
// non-topic Telegram). For threaded contexts (Slack threads, Telegram
// topics, Discord threads) it's the channel-native thread identifier.
//
// In-memory `getAllSessions()` returns a Record keyed by `sessionKey()` —
// folder + space + threadId — since folder names contain no spaces (they're
// sanitized filesystem identifiers) and channel-native thread ids never do.

export function sessionKey(
  groupFolder: string,
  threadId?: string | null,
): string {
  return `${groupFolder} ${threadId ?? ''}`;
}

export function parseSessionKey(key: string): {
  groupFolder: string;
  threadId: string;
} {
  const idx = key.indexOf(' ');
  if (idx < 0) return { groupFolder: key, threadId: '' };
  return { groupFolder: key.slice(0, idx), threadId: key.slice(idx + 1) };
}

export function getSession(
  groupFolder: string,
  threadId?: string | null,
): string | undefined {
  const tid = threadId ?? '';
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND thread_id = ?',
    )
    .get(groupFolder, tid) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  threadId: string | null | undefined,
  sessionId: string,
): void {
  const tid = threadId ?? '';
  // UPSERT preserving last_seen_ts. INSERT OR REPLACE would clobber the
  // cursor every time the SDK rotates its session id, breaking PR 5's
  // delta-only thread injection.
  db.prepare(
    `INSERT INTO sessions (group_folder, thread_id, session_id, last_seen_ts)
     VALUES (?, ?, ?, '')
     ON CONFLICT(group_folder, thread_id)
     DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, tid, sessionId);
}

export function deleteSession(
  groupFolder: string,
  threadId?: string | null,
): void {
  const tid = threadId ?? '';
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND thread_id = ?',
  ).run(groupFolder, tid);
}

/**
 * Delete every session for a group, regardless of thread. Used when a group
 * is removed or a global reset is needed.
 */
export function deleteAllSessionsForGroup(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

// --- Per-thread injection cursor (PR 5) ---
//
// `last_seen_ts` lives on the same (group_folder, thread_id) row as the
// session_id. It marks the timestamp of the most recent thread message we
// have already injected into the prompt — used to fetch only the delta on
// subsequent turns instead of re-sending the whole thread.

export function getSessionLastSeen(
  groupFolder: string,
  threadId?: string | null,
): string {
  const tid = threadId ?? '';
  const row = db
    .prepare(
      'SELECT last_seen_ts FROM sessions WHERE group_folder = ? AND thread_id = ?',
    )
    .get(groupFolder, tid) as { last_seen_ts: string } | undefined;
  return row?.last_seen_ts ?? '';
}

export function setSessionLastSeen(
  groupFolder: string,
  threadId: string | null | undefined,
  ts: string,
): void {
  const tid = threadId ?? '';
  // INSERT OR IGNORE creates the row if missing (no session_id yet — empty
  // string sentinel; the real session_id will be filled in by setSession on
  // the next agent turn). UPDATE then sets the cursor unconditionally.
  db.prepare(
    `INSERT OR IGNORE INTO sessions (group_folder, thread_id, session_id, last_seen_ts)
     VALUES (?, ?, '', ?)`,
  ).run(groupFolder, tid, ts);
  db.prepare(
    `UPDATE sessions SET last_seen_ts = ? WHERE group_folder = ? AND thread_id = ?`,
  ).run(ts, groupFolder, tid);
}

export function clearSessionLastSeen(
  groupFolder: string,
  threadId?: string | null,
): void {
  const tid = threadId ?? '';
  db.prepare(
    `UPDATE sessions SET last_seen_ts = '' WHERE group_folder = ? AND thread_id = ?`,
  ).run(groupFolder, tid);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, thread_id, session_id FROM sessions')
    .all() as Array<{
    group_folder: string;
    thread_id: string;
    session_id: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[sessionKey(row.group_folder, row.thread_id)] = row.session_id;
  }
  return result;
}

// --- Recovery state ---
//
// Sessions row stores per-(group, thread) recovery state so background
// sweep + boot hook can resume turns that failed mid-flight.
//   in_flight_since           — set on turn-start, cleared on clean exit
//   next_retry_at             — when to attempt next, NULL = not pending
//   attempt_count             — for budget tracking
//   last_error_type           — classifier output
//   last_error_details        — short description for forensics / give-up msg
//   pending_since_message_id  — stable anchor for the cancel reaction on give-up

export interface RecoveryRow {
  group_folder: string;
  thread_id: string;
  in_flight_since: string | null;
  next_retry_at: string | null;
  attempt_count: number;
  last_error_type: string | null;
  last_error_details: string | null;
  pending_since_message_id: string | null;
}

/** Mark a turn as in-flight at start. Idempotent. */
export function markTurnInFlight(
  groupFolder: string,
  threadId: string,
  triggerMessageId: string,
): void {
  const tid = threadId || '';
  const now = new Date().toISOString();
  // INSERT OR IGNORE first so we don't blow away an existing session row
  // (which holds session_id / last_seen_ts we want to preserve), then
  // UPDATE the recovery columns. The pending_since_message_id is set only
  // when no in_flight is currently active — preserves the anchor across
  // retries.
  db.prepare(
    `INSERT OR IGNORE INTO sessions (group_folder, thread_id, session_id, last_seen_ts)
     VALUES (?, ?, '', '')`,
  ).run(groupFolder, tid);
  db.prepare(
    `UPDATE sessions
     SET in_flight_since = COALESCE(in_flight_since, ?),
         pending_since_message_id = COALESCE(pending_since_message_id, ?)
     WHERE group_folder = ? AND thread_id = ?`,
  ).run(now, triggerMessageId, groupFolder, tid);
}

/** Schedule a retry. attemptCount is the number of failures so far. */
export function scheduleRetry(
  groupFolder: string,
  threadId: string,
  nextRetryAt: string,
  attemptCount: number,
  errorType: string,
  errorDetails: string,
): void {
  const tid = threadId || '';
  db.prepare(
    `UPDATE sessions
     SET next_retry_at = ?,
         attempt_count = ?,
         last_error_type = ?,
         last_error_details = ?
     WHERE group_folder = ? AND thread_id = ?`,
  ).run(nextRetryAt, attemptCount, errorType, errorDetails, groupFolder, tid);
}

/** Clear all recovery state — turn completed cleanly. */
export function clearRecoveryState(
  groupFolder: string,
  threadId: string,
): void {
  const tid = threadId || '';
  db.prepare(
    `UPDATE sessions
     SET in_flight_since = NULL,
         next_retry_at = NULL,
         attempt_count = 0,
         last_error_type = NULL,
         last_error_details = NULL,
         pending_since_message_id = NULL
     WHERE group_folder = ? AND thread_id = ?`,
  ).run(groupFolder, tid);
}

/** Recovery rows due for retry now. Ordered by oldest in_flight_since first. */
export function getDueRecoveries(now?: Date): RecoveryRow[] {
  const ts = (now ?? new Date()).toISOString();
  return db
    .prepare(
      `SELECT group_folder, thread_id,
              in_flight_since, next_retry_at, attempt_count,
              last_error_type, last_error_details, pending_since_message_id
       FROM sessions
       WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
       ORDER BY in_flight_since ASC NULLS LAST`,
    )
    .all(ts) as RecoveryRow[];
}

/** All rows with in_flight state. Used by boot hook. */
export function getAllInFlight(): RecoveryRow[] {
  return db
    .prepare(
      `SELECT group_folder, thread_id,
              in_flight_since, next_retry_at, attempt_count,
              last_error_type, last_error_details, pending_since_message_id
       FROM sessions
       WHERE in_flight_since IS NOT NULL`,
    )
    .all() as RecoveryRow[];
}

/** Read the current recovery row for a (group, thread), or null. */
export function getRecoveryStateForTurn(
  groupFolder: string,
  threadId: string | undefined,
): RecoveryRow | null {
  const tid = threadId || '';
  const row = db
    .prepare(
      `SELECT group_folder, thread_id,
              in_flight_since, next_retry_at, attempt_count,
              last_error_type, last_error_details, pending_since_message_id
       FROM sessions
       WHERE group_folder = ? AND thread_id = ?`,
    )
    .get(groupFolder, tid) as RecoveryRow | undefined;
  return row ?? null;
}

/** Reset next_retry_at for rows whose lock looks stale (boot hook). */
export function resetStaleRecoveryLocks(now?: Date): number {
  const ts = (now ?? new Date()).toISOString();
  const info = db
    .prepare(
      `UPDATE sessions
       SET next_retry_at = ?
       WHERE in_flight_since IS NOT NULL
         AND (next_retry_at IS NULL OR next_retry_at > ?)`,
    )
    .run(ts, ts);
  return info.changes;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    // Legacy JSON migration: pre-thread world had a single session per folder.
    // Carry that forward as the root session (thread_id='').
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, '', sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
