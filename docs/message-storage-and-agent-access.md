# Message Storage and Agent Access in NanoClaw

> How messages are persisted, how they flow into agent containers, and how agents can retrieve past messages within a single group.

---

## 1. Storage: Where Messages Live

### 1.1 SQLite database — the primary store

All message content is written to **`store/messages.db`** (a better-sqlite3 database) via `src/db.ts → storeMessage()`.

Schema of the `messages` table:

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT | Platform message ID (PRIMARY KEY with chat_jid) |
| `chat_jid` | TEXT | Group identifier (e.g. `tg:-100123456`, `120363@g.us`) |
| `sender` | TEXT | Sender's platform ID |
| `sender_name` | TEXT | Display name |
| `content` | TEXT | Raw message text |
| `timestamp` | TEXT | ISO 8601 |
| `is_from_me` | INTEGER | 1 if sent by the NanoClaw number |
| `is_bot_message` | INTEGER | 1 if sent by the agent (used to exclude from prompts) |
| `reply_to_message_id` | TEXT | Quoted message ID (if any) |
| `reply_to_message_content` | TEXT | Quoted message text |
| `reply_to_sender_name` | TEXT | Quoted message author |
| `thread_id` | TEXT | Thread context (Slack thread_ts, etc.) |

Index on `timestamp` for fast cursor-based queries.

### 1.2 Chat metadata — lightweight discovery table

The `chats` table stores one row per JID with only `name`, `last_message_time`, `channel`, and `is_group`. No content is stored here — it enables group discovery without persisting sensitive data for unregistered chats.

### 1.3 Session transcripts — agent conversation history

Each group has an isolated session directory at:

```
data/sessions/{group_folder}/.claude/projects/-workspace-group/{session_id}.jsonl
```

This JSONL file is maintained by the Claude Code SDK and contains the full back-and-forth between the user turns (formatted message batches) and the agent's responses. It is the agent's "working memory" across turns within a session.

The active session ID per group is tracked in the `sessions` table (`group_folder → session_id`).

### 1.4 Archived conversations — long-term memory

Before the SDK compacts context (triggered at ~165,000 tokens), a `PreCompact` hook in `container/agent-runner/src/index.ts` archives the session to:

```
groups/{group_folder}/conversations/{date}-{title}.md
```

These are plain Markdown files the agent can search freely with `Read`, `Grep`, `Glob`.

---

## 2. Ingest: How a Message Gets Stored

```
Channel (Telegram/Slack/WhatsApp/Discord)
  │
  ▼ onMessage(chatJid, msg)     [src/index.ts]
  │
  ├─ Intercept /remote-control commands (not stored)
  ├─ Sender allowlist drop mode (discards before storage)
  │
  ▼ storeMessage(msg)           [src/db.ts]
  │
  └─ SQLite INSERT OR REPLACE → messages table
     + storeChatMetadata() → chats table
```

**Bot replies are also stored** with `is_bot_message = 1`. Every subsequent query to build a prompt explicitly excludes them (`AND is_bot_message = 0`), so the agent never sees its own previous replies in the prompt batch.

---

## 3. Delivery: How Messages Reach the Agent

### 3.1 The message loop cursor

`src/index.ts` runs a poll loop every 2 seconds. Two cursors are tracked:

| Cursor | Meaning |
|--------|---------|
| `lastTimestamp` | Global cursor — newest message the loop has "seen" |
| `lastAgentTimestamp[chatJid]` | Per-group cursor — newest message that was delivered to an agent |

Both are persisted in the `router_state` SQLite table so they survive restarts.

### 3.2 New container flow (most messages)

```
startMessageLoop() polls every 2s
  │
  ▼ getNewMessages(allGroupJids, lastTimestamp)
  │   ↳ SQL: WHERE timestamp > ? AND chat_jid IN (?) AND is_bot_message = 0
  │          ORDER BY timestamp DESC LIMIT 200  (then re-sorted ASC)
  │
  ├─ [non-trigger group] no trigger word → message stored, loop moves on
  │
  └─ [trigger found OR main/no-trigger group]
       │
       ▼ getMessagesSince(chatJid, lastAgentTimestamp[chatJid])
       │   ↳ ALL messages since last agent cursor, up to MAX_MESSAGES_PER_PROMPT (default: 10)
       │   ↳ Includes non-trigger messages that accumulated between agent runs
       │
       ▼ formatMessages() → XML prompt
       │
       ├─ [container active] queue.sendMessage() → write JSON file to
       │                      data/ipc/{group_folder}/input/{ts}.json
       │                      Container polls this directory and picks it up
       │
       └─ [no active container] queue.enqueueMessageCheck()
             │
             ▼ processGroupMessages() → runContainerAgent()
               ↳ spawn container, pass prompt via stdin as ContainerInput JSON
```

### 3.3 Prompt format delivered to the agent

`formatMessages()` in `src/router.ts` produces XML:

```xml
<context timezone="Europe/Kiev" />
<messages>
<message sender="Alice" time="Apr 7, 2026, 2:30 PM" thread_ts="1234.5678" reply_to="msgid-9">
  <quoted_message from="Alice">original quoted text</quoted_message>
  @Andy can you find the message about the budget?
</message>
</messages>
```

The agent receives this as the `prompt` field inside `ContainerInput` JSON (via stdin). The agent-runner wraps it as the first user turn in a `MessageStream` passed to the SDK's `query()` function.

### 3.4 Piping follow-up messages to an active container

If a container is already running for a group when new messages arrive, the host writes a JSON file to `data/ipc/{group_folder}/input/`. The agent-runner polls this directory every 500ms and pushes new messages into the active `MessageStream`, so the running agent continues its turn with the new input without needing a new container.

---

## 4. Agent Memory: What the Agent Can Access Inside the Container

### Layer 1 — The current prompt (immediate context)

The formatted XML block of the latest N messages (up to `MAX_MESSAGES_PER_PROMPT = 10`). This is what triggered the current agent run.

**Limitation**: Only messages since `lastAgentTimestamp[chatJid]`. A message from three days ago will not appear here.

### Layer 2 — Session continuation (SDK .jsonl)

When `runContainerAgent()` passes `sessionId` to the SDK via `resume: sessionId`, the full conversation history from the JSONL file is loaded. The agent can directly reference everything said in previous turns of the same session.

The session is kept alive for up to 30 minutes of idle time (`IDLE_TIMEOUT`). As long as the session hasn't been compacted or cleared, the agent effectively has a rolling window of every message it has ever received in this group.

### Layer 3 — Archived conversations (file search)

When the session grows past ~165,000 tokens, the SDK compacts it. Before compaction, a hook saves the full transcript to:

```
/workspace/group/conversations/{date}-{summary-title}.md
```

The agent is instructed (via `CLAUDE.md`):

> "The `conversations/` folder contains searchable history of past conversations. Use this to recall context from previous sessions."

The agent uses standard tools (`Grep`, `Read`, `Glob`) to search these files by keyword, date, or pattern.

### Layer 4 — Custom knowledge files

Agents are instructed to create structured files for important information (`customers.md`, `preferences.md`, etc.) in `/workspace/group/`. These persist across sessions and are always available.

### Layer 5 — Direct SQLite access (main group only)

The **main group container** has read-write access to `/workspace/project/store/messages.db`. It can run arbitrary SQL:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT sender_name, content, timestamp
  FROM messages
  WHERE chat_jid = 'tg:-100123456'
    AND content LIKE '%budget%'
  ORDER BY timestamp DESC
  LIMIT 10;
"
```

Non-main group containers do **not** have the store mounted — they can only search their own files and session history.

---

## 5. The "Find a Past Message" Scenario

**Setup**: User sent a message in group X. Hours or days later, asks the agent to find it.

```
User: "find that message about the Q3 budget"
```

**What the agent receives in the prompt**:

Only messages since `lastAgentTimestamp[chatJid]` — i.e., messages since the last time the agent processed this group. The original message about Q3 budget will be in the prompt only if it was sent after the last agent cursor (recently enough to be in the 10-message window).

**How the agent searches beyond the prompt**:

1. **Session history (Layer 2)** — If the original message came in during the same session and the session hasn't been compacted, it's in the JSONL and the agent "remembers" it implicitly as conversation context. The agent can reference it directly without any explicit search.

2. **Archived conversations (Layer 3)** — If the session was compacted, the transcript was saved to `conversations/`. The agent runs:
   ```bash
   grep -r "budget" /workspace/group/conversations/
   ```

3. **Custom notes (Layer 4)** — If the agent previously wrote a note about the budget discussion, it searches its knowledge files.

4. **SQLite direct query (Layer 5, main group only)** — The main group agent can query the full message history across all time:
   ```sql
   SELECT sender_name, content, timestamp
   FROM messages
   WHERE chat_jid = ? AND content LIKE '%budget%'
   ORDER BY timestamp DESC LIMIT 5;
   ```

**Non-main groups cannot query SQLite directly.** If a non-main group agent needs to find an old message that is no longer in active session context and was not written to `conversations/`, it cannot find it — unless the user provides more context to narrow it to something in the agent's files or recent session.

---

## 6. Context Mode for Scheduled Tasks

Scheduled tasks have a `context_mode` field:

| Mode | Behavior |
|------|----------|
| `group` | Task container resumes the group's current session ID — agent has full conversation context |
| `isolated` | Task runs with no session — fresh start, no conversation history |

This is relevant when a task is scheduled to "remind me about our discussion" vs. "check the weather".

---

## 7. Retention and Cleanup

| Artifact | Location | Retention |
|----------|----------|-----------|
| SQLite `messages` table | `store/messages.db` | **Indefinite** (no automatic pruning) |
| SQLite `chats` table | `store/messages.db` | **Indefinite** |
| Session JSONL files | `data/sessions/{group}/.claude/projects/-workspace-group/` | 7 days (inactive); active session kept forever |
| Tool-results dirs | `data/sessions/{group}/.claude/projects/-workspace-group/{id}/` | 7 days (inactive) |
| Debug logs | `data/sessions/{group}/.claude/debug/` | 3 days |
| Todo files | `data/sessions/{group}/.claude/todos/` | 3 days |
| Telemetry | `data/sessions/{group}/.claude/telemetry/` | 7 days |
| Container run logs | `groups/{group_folder}/logs/` | 7 days |
| Archived conversations | `groups/{group_folder}/conversations/` | **Indefinite** (agent-managed) |

Cleanup runs via `scripts/cleanup-sessions.sh`, invoked by `startSessionCleanup()` on startup (after 30s delay) and every 24 hours. The active session is never deleted regardless of age.

---

## 8. Summary Diagram

```
Message arrives on channel
         │
         ▼
  storeMessage() → SQLite messages table (forever)
         │
         ▼ (2s poll)
  getMessagesSince(cursor) → last 10 non-bot messages
         │
         ▼
  formatMessages() → XML prompt
         │
    ┌────┴────────────────────┐
    │ Active container?        │
    │                         │
   Yes                        No
    │                         │
    ▼                         ▼
  Write to IPC         Spawn new container
  ipc/{group}/input/   (stdin ContainerInput JSON)
         │
         ▼
  Agent runner reads prompt
         │
  Accesses context via layers:
    1. Current prompt XML (recent messages)
    2. SDK session resume (.jsonl history)
    3. conversations/ archived Markdown files
    4. Custom knowledge files in /workspace/group/
    5. Direct SQLite query (main group only)
```
