# Global Memory — trusted scope

Read [`memory.md`](../core/memory.md) first for the general mental model and the frontmatter / confirmation / recall rules. This file covers what is specific to the trusted tier.

## Your write privileges

You have **read-write** access to `/workspace/global/`. The mount is rw for your tier and for admin/main; read-only only for untrusted.

But every write you make lands as **`status: unconfirmed`** and waits for an admin/is_main group to confirm via the pending-confirmations procedure. Trusted groups **cannot self-confirm**, even by editing their own files — confirmation is the admin tier's job.

In practice, this means:

- You can create new files under `/workspace/global/memory/<domain>/...`.
- You can append new content to existing files (e.g. add a section under a heading).
- Every new write **must** carry the frontmatter from `core/memory.md` (`status: unconfirmed`, `pending_for: <messenger>_main`, `created_by`, `created_at`).
- You **must not** flip `status: unconfirmed` to `status: confirmed`. If the user in your group says "подтверждаю" — relay that you can't self-confirm, and that the corresponding admin group will handle it.
- You **must not** edit the content of an existing **confirmed** record unilaterally. If you believe a confirmed record is wrong or outdated, write a new unconfirmed entry that supersedes it (and references it), and let admin do the merge/replace.

## The three indexed sources

The semantic memory index reads markdown from three roots and assigns each chunk a **scope** plus zero or more **domains**.

| Source | Path | Scope | Who reads it |
|---|---|---|---|
| Group CLAUDE.md | `/workspace/group/CLAUDE.md` | `group` | Only your group |
| Group wiki | `/workspace/group/wiki/**/*.md` | `group` | Only your group |
| Global memory | `/workspace/global/memory/**/*.md` | `global` | All groups except untrusted |

## Domain tagging

Domains scope a chunk to a topic. Two ways they get assigned, **merged** by the indexer:

1. **Folder name = domain** (the primary mechanism). The first subfolder under `groups/global/memory/` defines the file's domain:

   ```
   groups/global/memory/resell/feeds-mcp.md     → domain: ["resell"]
   groups/global/memory/billing/invoicing.md    → domain: ["billing"]
   groups/global/memory/2026-04-28-summary.md   → domain: []   (top-level = visible everywhere)
   ```

2. **Frontmatter `domains: [...]`** — adds extra domains, merged with the folder one:

   ```yaml
   ---
   name: feeds-mcp
   description: How to use feeds-mcp tools
   domains: ["billing", "tcb"]
   ---
   ```

   For a file at `groups/global/memory/resell/feeds-mcp.md` with the frontmatter above, the indexer assigns `domains: ["resell", "billing", "tcb"]`.

## Filename conventions

- **Lowercase, hyphen-separated:** `feeds-mcp.md`, not `Feeds_MCP.md`. Search ranks higher when filename matches the topic.
- **Topical for knowledge files:** `resell-billing-rules.md`, `project-status.md`, `contacts.md`.
- **Chronological for summaries / event logs:** `YYYY-MM-DD-summary.md`, `YYYY-MM-DD-events.md`. These belong at the top level (domain-less, visible everywhere).

## After every edit: `memory_reindex`

```
memory_reindex                    # no args = partial reindex of all sources
memory_reindex({ filePath: "/workspace/global/memory/resell/feeds-mcp.md" })
```

Partial mode (default) skips files whose SHA-256 hasn't changed — calling `memory_reindex` with no args after every edit is cheap and safe.

`filePath` accepts container paths or absolute host paths. If it returns `filesIndexed: 0, filesSkipped: 0` with a `filePath` argument, the path didn't match any source root — check that it lives under `/workspace/group/`, `/workspace/group/wiki/`, or `/workspace/global/memory/`.

## Where to write what

| Knowledge type | Destination |
|---|---|
| One-off note for this group only | `/workspace/group/wiki/<topic>.md` |
| Group's identity / persistent prefs | `/workspace/group/CLAUDE.md` |
| Cross-group knowledge for one project | `/workspace/global/memory/<domain>/<topic>.md` (unconfirmed) |
| Cross-group knowledge for many projects | `/workspace/global/memory/<topic>.md` (top-level, domain-less, unconfirmed) — use sparingly |
| Daily / weekly summary visible to all | `/workspace/global/memory/<YYYY-MM-DD>-summary.md` (unconfirmed) |

## When to write global memory

- User asks to summarize, research, or log something for future reference.
- User says "remember this", "save this", "add to memory" — default destination, ask for the domain if it isn't obvious.
- Daily/weekly summaries requested.
- Cross-group information that other groups should see.

In all cases the resulting file gets `status: unconfirmed` and the standard `💾 Saved → ... ⚠️ unconfirmed (pending <messenger>_main)` confirmation line.

## Researching "what happened"

To answer questions like "what happened yesterday" or "list recent events":

1. Query `messages.db` for recent messages across all groups:

```python
import sqlite3
conn = sqlite3.connect('/workspace/project/store/messages.db')
rows = conn.execute("""
    SELECT m.chat_jid, c.name, m.sender_name, m.content, m.timestamp
    FROM messages m
    JOIN chats c ON m.chat_jid = c.jid
    WHERE m.timestamp > datetime('now', '-1 day')
      AND m.is_bot_message = 0
    ORDER BY m.timestamp DESC
    LIMIT 100
""").fetchall()
for r in rows: print(r)
conn.close()
```

2. Summarize the findings.
3. Save the summary to `/workspace/global/memory/` as an unconfirmed entry with the standard frontmatter.
4. Report back with the `💾 Saved` confirmation line.
