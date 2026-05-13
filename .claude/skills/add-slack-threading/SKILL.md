---
name: add-slack-threading
description: Add Slack threading support — bot replies in threads, agent sees full thread context with per-thread session isolation and delta-only re-injection. Includes explicit context-completeness markers so the agent knows when its visible thread is exhaustive vs a delta. Requires Slack channel set up first (use /add-slack). Triggers on "slack threading", "slack threads", "reply in thread", "thread support", "thread context".
---

# Add Slack Threading Support

This is the umbrella skill for everything thread-related. It bundles four concerns that have to land together to behave correctly:

1. **Reply in thread** — bot always replies in a thread (creates one for top-level messages, replies in existing threads).
2. **Whole-thread context fetch** — when triggered from a thread, the orchestrator injects the entire thread (parent + all replies) into the agent's prompt, bypassing the per-channel `MAX_MESSAGES_PER_PROMPT` window. Capped at 500 messages / 200 KB as a safety net.
3. **Per-thread SDK sessions + delta-only injection** — each thread gets its own isolated SDK session. After the first turn the orchestrator injects only the messages newer than the last cursor, so cumulative cache_creation across N turns stays O(thread_size), not O(thread_size × N).
4. **Explicit `<context>` metadata** — every prompt opens with a self-closing `<context>` tag whose attributes tell the agent exactly what's in `<messages>`: full vs delta, truncated vs not, `total_thread_messages`, `since`, etc. The companion rule (`rules/core/conversation-history.md`) makes these attributes a contract so the agent doesn't burn turns on redundant `get_thread` calls.

The companion skill **`add-conversation-history-tools`** is recommended alongside — it adds four channel-agnostic MCP tools (`list_recent_messages`, `list_threads`, `get_thread`, `search_messages`) the agent can call when it needs to research beyond the visible thread. The threading skill writes the `<context>` attributes, the tools skill consumes them.

## Prerequisites

Slack channel must already be set up — `src/channels/slack.ts` must exist. Run `/add-slack` first if not.

## Files touched

| File | What this skill changes |
|---|---|
| `src/channels/slack.ts` | `thread_id = msg.thread_ts \|\| msg.ts` so top-level messages create their own thread when the bot replies. |
| `src/db.ts` | New helpers: `getThreadMessages`, `getThreadMessagesSince`, `getRootMessagesSince`. New `last_seen_ts` column on `sessions` (idempotent migration). `setSession` switched to `ON CONFLICT DO UPDATE` so SDK rotates don't clobber the cursor. New `getSessionLastSeen` / `setSessionLastSeen` / `clearSessionLastSeen`. |
| `src/index.ts` | `processGroupMessages` branches on `isThreadTrigger`. Thread → fetch full or delta; root → exclude thread chatter from the last-N window. Cursor advances after fetch. |
| `src/router.ts` | `formatMessages` accepts a `ContextInfo` object and renders attributes on `<context>`. |
| `rules/core/conversation-history.md` | Documents how the agent should read `<context>` and treat the visible `<messages>` block. |
| `groups/{folder}/conversations/threads/{thread_id}/...` | Per-thread archive paths from the agent-runner PreCompact hook. |

## Behavior matrix

| Trigger | What's in `<messages>` | `<context>` attributes the agent sees |
|---|---|---|
| Slack root @-mention, fresh thread | Last `MAX_MESSAGES_PER_PROMPT` top-level messages, thread chatter filtered out | `mode="root" channel_window="N"` |
| Slack thread reply, first turn (fresh session) | Entire thread, parent + all replies | `mode="thread" injection="full" truncated="false" total_thread_messages=N shown=N` |
| Slack thread reply, first turn (huge thread > cap) | Parent + most-recent replies; older middle dropped | `mode="thread" injection="full" truncated="true"` |
| Slack thread reply, subsequent turns | Only messages newer than last cursor | `mode="thread" injection="delta" since="..." total_thread_messages=N shown=delta_count` |
| Slack thread reply, after session rotation | Cursor cleared by `deleteSession`; re-injects full thread | `mode="thread" injection="full"` |

## Hard contract for the agent

The companion rule at `rules/core/conversation-history.md` enforces:

- `<context>` says `injection="full" truncated="false"` → don't call `get_thread`. Visible `<messages>` is exhaustive.
- `<context>` says `injection="delta"` → earlier thread context is in your prior conversation turns. Don't call `get_thread` to "verify".
- `<context>` says `truncated="true"` → use `search_messages` for keyword-targeted lookups in the dropped middle.

This eliminates the failure mode where the agent reflexively grep'd the `conversations/` archive or called `get_thread` for data that was already in front of it.

## Build and restart

```bash
npm run build
pm2 restart nanoclaw   # or whatever service manager runs nanoclaw
```

The `last_seen_ts` migration is idempotent — runs once on existing DBs, no-op afterwards. No Docker rebuild needed.

## Verify

End-to-end smoke test in any Slack channel registered with the bot:

1. Send a top-level @-mention. Bot replies **in a thread** under your message.
2. In that thread, post 2-3 unrelated messages without mentioning the bot. Then @-mention again.
3. The bot's reply context should reflect the whole thread (it'll know about the messages you posted between mentions).
4. Inspect the prompt that arrived at the SDK: `<context>` should have `mode="thread"` and `injection="full"` on the first thread turn, `injection="delta"` on subsequent ones.

Quick DB-level smoke (cumulative payload check):

```bash
node -e "const D=require('./node_modules/better-sqlite3'); \
  const db=new D('store/messages.db',{readonly:true}); \
  const s=db.prepare(\"SELECT group_folder, thread_id, last_seen_ts FROM sessions WHERE thread_id != ''\").all(); \
  for (const r of s) console.log(r.group_folder, r.thread_id, '→ last_seen', r.last_seen_ts);"
```

Each row is a thread the bot has been activated in; `last_seen_ts` is the cursor.

The vitest suite covers the invariants:

```bash
npx vitest run src/db.test.ts src/router.test.ts
```

`per-thread delta injection (PR 5)` proves no message id repeats across consecutive turns. `formatMessages — context attributes` proves the right XML attributes land on `<context>` for each scenario.

## Limitations / edges

- **Cap behavior**: when the cap kicks in (thread > 500 msgs or 200 KB), the parent + most-recent replies are kept, middle dropped. `truncated="true"` flags it; agent should use `search_messages` for keyword-targeted lookups in the missing middle.
- **Session rotation = re-inject**: when `rotateIfPoisoned` or thrash circuit-breaker fires, `deleteSession` removes the row and the cursor with it. Next turn re-injects the full thread, which is correct because the SDK transcript was wiped at the same time.
- **Cross-thread reference**: bot can't currently reach OTHER threads in the same channel from inside a thread session unless the user installs `add-conversation-history-tools`. With those tools, `list_threads` + `get_thread` cover that case.

## Rollback

```bash
git revert <PR commit hash>
npm run build && pm2 restart nanoclaw
```

The `last_seen_ts` column is left in place by revert (forward-compatible; older code ignores it). To fully wipe, drop the column with `ALTER TABLE sessions DROP COLUMN last_seen_ts` (SQLite 3.35+).

## Related skills

- `/add-slack` — channel registration prerequisite
- `/add-conversation-history-tools` — channel-agnostic history tools that complement this skill
- `/add-progress-reactions` — orthogonal but commonly applied together for Slack feel
