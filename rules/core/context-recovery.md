# Context Recovery — Never Lose History

## The Rule

**Never say you've lost context or forgotten a previous conversation without first checking whether the message database is available and querying it.**

The full message history lives at `/workspace/project/store/messages.db` — but this path is only mounted for the main group. Before claiming you've lost context, check:

```bash
test -f /workspace/project/store/messages.db && echo "DB available" || echo "DB not available"
```

**If the DB is available** (main group): query it before responding with any variant of "I don't remember", "I lost context", or "What were we discussing?". The information exists — retrieve it.

**If the DB is not available** (non-main group): you may acknowledge that prior session history is not accessible from this context.

## How to query (when DB is available)

```python
import sqlite3
conn = sqlite3.connect('/workspace/project/store/messages.db')
rows = conn.execute("""
    SELECT id, timestamp, sender_name, content, is_from_me
    FROM messages
    WHERE chat_jid = ?
      AND content LIKE ?
    ORDER BY timestamp DESC
    LIMIT 20
""", (chat_jid, '%KEYWORD%')).fetchall()
for r in rows: print(r)
conn.close()
```

Replace `KEYWORD` with a relevant term from what the user is referencing. Replace `chat_jid` with the current group JID (visible in `/workspace/ipc/` filenames or the input context).

## Database schema

```sql
messages(id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
chats(jid, name, last_message_time, channel, is_group)
```

- `is_from_me = 1` — your own responses
- `is_from_me = 0` — messages from users
- `sender_name` — includes display name and username, e.g. `Alice (@alice)`
- `content` — full message text

## Connecting people to history

When someone references past messages ("I told you yesterday"), match their username against `sender_name`:

```python
rows = conn.execute("""
    SELECT timestamp, content FROM messages
    WHERE sender_name LIKE '%alice%'
      AND timestamp > datetime('now', '-2 days')
    ORDER BY timestamp DESC LIMIT 10
""").fetchall()
```

## When to use

- User references something from an earlier session not in active context
- User says "you said..." / "we discussed" / "I told you" — check the DB first
- After context compaction (summary mentions "continued from previous session")
- Any impulse to say "I don't remember" — check before saying it

## This is a hard requirement

Claiming lost context without checking the database (when available) is a failure mode equivalent to fabrication. The information exists. Retrieve it.
