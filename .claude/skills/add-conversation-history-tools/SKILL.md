---
name: add-conversation-history-tools
description: Add four channel-scoped MCP tools (list_recent_messages, list_threads, get_thread, search_messages) so the agent can research past chat content beyond the visible <messages> block. Plus the explicit <context> attribute contract that tells the agent when those tools would actually return new info. Channel-agnostic — works for any registered channel (Slack, Telegram, WhatsApp, Discord). Triggers on "history tools", "conversation history", "search messages", "list threads", "get thread tool".
---

# Add Conversation-History Tools

Adds two related capabilities the agent uses to navigate past chat content:

1. **Four MCP tools** the agent can call to look beyond the visible `<messages>` block:
   - `list_recent_messages(limit, scope, since)` — last N messages from this channel; `scope='root'` skips thread chatter.
   - `list_threads(limit, since)` — recent thread parents with reply count, participants, last activity. Empty array on non-threading channels.
   - `get_thread(thread_id)` — every message of a specific thread, chronological. Reuses the same DB helper that drives whole-thread injection.
   - `search_messages(query, limit, since, sender)` — substring search; results grouped by thread on threading channels (Slack, Telegram topics, Discord), flat on DM-only channels.
2. **Explicit `<context>` attributes on every prompt** so the agent knows whether it actually needs to call any of these tools, or whether the visible `<messages>` block already covers what the user asked about.

Companion to `add-slack-threading` — that skill writes the `<context>` metadata; this skill reads it and consumes the four tools when the metadata says more lookup is warranted. Either skill works without the other; together they form the full picture.

## Why both pieces?

The tools by themselves are useful but lead to over-fetching: the agent calls `get_thread` defensively even when the visible `<messages>` block already has the entire thread. The `<context>` attributes make that explicit so the agent has a hard rule for when to call vs not. Without the contract, you get the slack_main "47 tool calls for a 24-message summary" failure mode.

## Files touched

| File | Change |
|---|---|
| `src/db.ts` | New helpers: `listRecentMessages`, `listThreads`, `searchMessages` (returns grouped-by-thread structure on threading channels). |
| `src/ipc.ts` | Four new dispatcher cases (`list_recent_messages`, `list_threads`, `get_thread`, `search_messages`). Same writeResp pattern as `memory_search` — agent writes a request file with a `requestId`, host writes the response, agent polls. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Four `server.tool(...)` registrations. The `callMemoryRpc` helper was generalized into `callIpcRpc` and reused for all four. |
| `src/router.ts` | `formatMessages` accepts a `ContextInfo` object; renders attributes on the `<context>` self-closing tag. |
| `src/index.ts` | The two `formatMessages` call sites in `processGroupMessages` populate `ContextInfo` based on the trigger mode (thread/root) and the injection style (full/delta/truncated). |
| `rules/core/conversation-history.md` | Hard contract: when `<context>` says you have everything, do not call these tools. Lists the exact attribute combinations and what each implies. |

## The `<context>` attributes — what the agent sees

Self-closing tag at the top of every prompt. Attributes are emitted only when relevant:

```xml
<context timezone="UTC"
         mode="thread|root"
         thread_id="..."           (when mode="thread")
         injection="full|delta"    (when mode="thread")
         truncated="true|false"    (when mode="thread")
         total_thread_messages="N" (when mode="thread")
         shown="N"
         since="..."               (when injection="delta")
         channel_window="N"        (when mode="root")
/>
```

The rule (`rules/core/conversation-history.md`) maps each combination to whether `get_thread`/`search_messages` would add anything:

| `<context>` says | Tool call worth making? |
|---|---|
| `injection="full" truncated="false"` | **No** — `<messages>` is exhaustive for this thread. |
| `injection="full" truncated="true"` | **Maybe** — middle messages dropped; `search_messages` for keyword lookup, `get_thread` returns same truncated set. |
| `injection="delta"` | **No** — earlier thread context is in your prior conversation turns; you already have it. |
| `mode="root"` + user references a thread | **Yes** — `list_threads` to find the thread, `get_thread` to read it. |

## Tool ACL

All four tools are **scoped to the calling group's `chat_jid`** — no `chat_jid` parameter. The agent can't query other channels' history, even if it knows their JIDs. Defense in depth: the host-side handler reads `chat_jid` from the registered group record, ignoring anything the agent sends.

## Build and restart

```bash
npm run build
pm2 restart nanoclaw   # or your service manager
```

The agent-runner's source is per-group cached at `data/sessions/{folder}/agent-runner-src/`. The container's entrypoint recompiles on startup, so no Docker rebuild is needed — but if you see the new tools missing inside a specific group's container, force a fresh agent-runner cache:

```bash
rm -rf data/sessions/<group>/agent-runner-src
docker stop $(docker ps --filter name=nanoclaw-<group>- -q)
```

Next message in that group spawns a fresh container with the updated tools.

## Verify

End-to-end, from inside a registered Slack channel:

1. Trigger the bot in a thread that's been going for a while.
2. Ask: "найди в этом канале сообщения про макрос" / "search this channel for messages about macros".
3. The agent should call `search_messages({query: 'macro', ...})` once, see the grouped-by-thread result, and report findings.

DB-level smoke (no agent needed):

```bash
node -e "
const { initDatabase, listThreads, searchMessages } = require('./dist/db.js');
initDatabase();
const chat = 'slack:YOUR_CHANNEL_ID';
console.log('threads:', listThreads(chat, { limit: 3 }));
console.log('search:', searchMessages(chat, 'keyword', { limit: 5 }));
"
```

Test suite:

```bash
npx vitest run src/router.test.ts        # 6 cases for <context> attribute rendering
npx vitest run src/db.test.ts            # includes 5 cases for thread fetching invariants
```

## Limitations

- **Plain LIKE search.** `search_messages` does substring match (`content LIKE '%query%'`), no ranking, no fuzzy. Specific keywords work; phrases with stopwords don't filter well. FTS5 + vector search is planned future work.
- **Per-thread group only.** No cross-channel search. Add a tool with explicit cross-channel ACL (and a per-tier safety check) if/when that's actually needed.
- **No bot-message filter on history tools.** `list_recent_messages` and `search_messages` return everything including the bot's own replies — that's intentional for "what did I say last week" lookups but means a "search for 'thanks'" will hit bot replies too.

## Rollback

```bash
git revert <PR commit hash>
npm run build && pm2 restart nanoclaw
```

The four tool registrations disappear from the agent's tool list on next container spawn. The `<context>` tag falls back to just `timezone="..."`.

## Related skills

- `/add-slack-threading` — companion that writes the `<context>` attributes. Use both for the full picture.
- `/add-mcp-to-gateway` — different mechanism for adding MCPs (host-side gateway). The history tools live in nanoclaw's own MCP server, not the gateway, because they need direct DB access on the host and are channel-agnostic.
