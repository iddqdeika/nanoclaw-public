---
name: add-telegram-swarm
description: Add Agent Swarm (Teams) support to Telegram. Each subagent gets its own bot identity in the group via a pool of pre-created BotFather bots that get renamed at runtime to match the role. Pool initialized from TELEGRAM_BOT_POOL env. Threads `thread_ts` (integer-only) and `icon_emoji` (no-op on Telegram) through the same swarm wiring as Slack. Telegram channel must exist; persona library recommended. Triggers on "agent swarm", "telegram swarm", "telegram agent teams", "bot pool".
---

# Add Agent Swarm to Telegram

Adds swarm/team support to an existing Telegram channel. Subagents call `mcp__nanoclaw__send_message(text, sender: "<role>")`. The host picks a pool bot, renames it to the role via `setMyName`, and sends from that bot's `Api` instance — so each persona shows up in the Telegram group as a separate bot identity.

This is the Telegram counterpart to `/add-slack-swarm`. Telegram doesn't have Slack's `chat.postMessage` per-call `username`/`icon_emoji` trick — bot identity is a *bot*, not a parameter. So we need a pool of N pre-created bots and rename them at runtime.

## How it works

- The **main bot** (already from `/add-telegram`) handles inbound polling and lead-agent replies.
- **Pool bots** are send-only `Api` instances — no polling, no event handlers. Each gets renamed once per (group, sender) pair on first use.
- Sender→bot mapping is stable per orchestrator session, keyed `{groupFolder}:{senderName}`. After a service restart, mappings reset and the next swarm assignment is fresh.
- `icon_emoji` parameter from the unified swarm IPC is accepted but ignored (Slack-only — Telegram has no per-message avatar concept).
- `thread_ts` is honoured **only** when the value is a clean integer string (Telegram topic id). Slack-style `"1234.5678"` timestamps that leak across channels are silently dropped to avoid `MESSAGE_THREAD_NOT_FOUND`.

## Files touched

| File | What this skill changes |
|---|---|
| `src/channels/telegram.ts` | New private fields `poolTokens`, `poolApis`, `senderBotMap`, `nextPoolIndex`. New `private async initBotPool()` (called from `connect` after `onStart`). New `async sendPoolMessage(jid, text, sender, groupFolder, _iconEmoji?, threadId?)` method. Existing `sendMessage` and `sendPoolMessage` both validate `threadId` against `/^\d+$/` before passing as `message_thread_id` (defensive against Slack-ts leaks and non-topic chats). The `registerChannel` factory reads `TELEGRAM_BOT_POOL` from env (or from `data/env/env`-style file via `readEnvFile`) and passes the parsed token list to the constructor. |
| `src/types.ts` | `Channel.sendPoolMessage?` interface gains optional `iconEmoji?: string` and `threadId?: string` parameters. (No-op on Telegram for `iconEmoji`; same signature shape as Slack.) |
| `src/ipc.ts` | `IpcDeps.sendPoolMessage` signature gains the same extras. The message-IPC handler (in `processIpcFiles`) routes to `deps.sendPoolMessage` when `data.sender` is set, threading `data.icon_emoji` and `data.threadTs`. |
| `src/index.ts` | `startIpcWatcher` wiring forwards both extras. Fallback path (channel without `sendPoolMessage`) prefixes `[Sender] ` and still passes `threadId`. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `send_message` MCP tool gains optional `icon_emoji: z.string().optional()` (Slack-only; harmless for Telegram). The tool's IPC payload includes `icon_emoji` alongside `sender`. |
| `groups/telegram_*/CLAUDE.md` | New "Agent Teams (swarm)" section in each Telegram group you want teams enabled in. Points to `/workspace/global/memory/personas.md` for canonical roles. |
| `.env` and `data/env/env` | New `TELEGRAM_BOT_POOL=token1,token2,token3,...` line (comma-separated). |

No Docker rebuild needed — `agent-runner` source is copied per-group from `container/agent-runner/src/` by mtime, picks up the MCP tool change automatically on next agent spawn. Orchestrator restart is enough.

## Prerequisites

1. **Telegram channel installed.** `src/channels/telegram.ts` must exist. If not, run `/add-telegram` first.
2. **Persona library installed** (`/add-persona-library`). This installs typed sub-agents in `.claude/agents/<role>.md` so lead can call `Task(subagent_type: "<name>")` with auto-applied tool/model/system-prompt. Without it, lead has to inline persona instructions in every spawn prompt — fragile and verbose. Strongly recommended.
3. **N pool bots created via @BotFather** with Group Privacy disabled. See "Step 1" below.
4. **(Optional) Slack swarm already installed** (`/add-slack-swarm`). If so, several files (Channel interface, IPC routing, MCP tool, index wiring) are already partially patched and this skill only adds the Telegram-specific bits.

## Implementation

### Step 1: Create the pool bots

Tell the user:

> Open Telegram, find @BotFather. For each pool slot you want (recommend 3–5):
>
> 1. Send `/newbot`. Give any placeholder name and a unique username like `myproject_swarm_1_bot`, `myproject_swarm_2_bot`, etc.
> 2. Copy each bot's token.
> 3. For every bot: `/mybots` → select the bot → **Bot Settings** → **Group Privacy** → **Turn off**. Without this they can't post in groups.
> 4. Add all pool bots to the Telegram group(s) where you want agent teams.
> 5. Send all tokens back to me, comma-separated, in `.env` form: `TELEGRAM_BOT_POOL=tok1,tok2,tok3`.

Wait for tokens before proceeding.

### Step 2: Add the env var

Append to both `.env` and `data/env/env` (the latter is the file-mounted env source for containers — if you're not using OneCLI / native credential proxy file mounts, only `.env` matters):

```
TELEGRAM_BOT_POOL=token1,token2,token3
```

### Step 3: Patch `src/types.ts`

Extend `Channel.sendPoolMessage?` with the unified swarm signature (same as Slack swarm — if both are installed they share this method):

```typescript
sendPoolMessage?(
  jid: string,
  text: string,
  sender: string,
  groupFolder: string,
  iconEmoji?: string,
  threadId?: string,
): Promise<void>;
```

### Step 4: Patch `src/channels/telegram.ts`

Several edits in this file:

**4a. Add pool fields and constructor param.** In the `TelegramChannel` class:

```typescript
private poolTokens: string[] = [];
private poolApis: Api[] = [];
private senderBotMap = new Map<string, number>();
private nextPoolIndex = 0;

constructor(
  botToken: string,
  opts: TelegramChannelOpts,
  poolTokens: string[] = [],
) {
  this.botToken = botToken;
  this.opts = opts;
  this.poolTokens = poolTokens;
}
```

**4b. Add `initBotPool` and `sendPoolMessage`.** Place before `isConnected()`:

```typescript
private async initBotPool(): Promise<void> {
  if (this.poolTokens.length === 0 || this.poolApis.length > 0) return;
  for (const token of this.poolTokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      this.poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: this.poolApis.length },
        'Telegram pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Telegram pool bot');
    }
  }
  if (this.poolApis.length > 0) {
    logger.info({ count: this.poolApis.length }, 'Telegram bot pool ready');
  }
}

async sendPoolMessage(
  jid: string,
  text: string,
  sender: string,
  groupFolder: string,
  _iconEmoji?: string,
  threadId?: string,
): Promise<void> {
  if (this.poolApis.length === 0) {
    await this.sendMessage(jid, text, threadId);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = this.senderBotMap.get(key);
  if (idx === undefined) {
    idx = this.nextPoolIndex % this.poolApis.length;
    this.nextPoolIndex++;
    this.senderBotMap.set(key, idx);
    try {
      await this.poolApis[idx].setMyName(sender);
      // Telegram needs a moment to propagate the rename before
      // the first message lands under the new identity.
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Telegram: assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Telegram: failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = this.poolApis[idx];
  try {
    const numericId = jid.replace(/^tg:/, '');
    // Only honour threadId when it's a pure integer (Telegram topic id).
    // Slack-style "1234.5678" timestamps would parseInt-truncate to garbage
    // and Telegram returns MESSAGE_THREAD_NOT_FOUND. Non-topic chats also
    // reject any thread_id, so when in doubt — drop it.
    const options =
      threadId && /^\d+$/.test(threadId)
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text, options);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(api, numericId, text.slice(i, i + MAX_LENGTH), options);
      }
    }
    logger.info(
      { jid, sender, poolIndex: idx, threadId, length: text.length },
      'Telegram pool message sent',
    );
  } catch (err) {
    logger.error({ jid, sender, err }, 'Failed to send Telegram pool message');
  }
}
```

**4c. Apply the same threadId-integer-check to the existing `sendMessage`.** Find:

```typescript
const options = threadId
  ? { message_thread_id: parseInt(threadId, 10) }
  : {};
```

Replace with:

```typescript
const options =
  threadId && /^\d+$/.test(threadId)
    ? { message_thread_id: parseInt(threadId, 10) }
    : {};
```

This is a pre-existing latent bug — fixing it here keeps both code paths symmetric.

**4d. Init pool in `connect()`.** In the bot's `start({ onStart })` callback, after `this.startHealthCheck()`:

```typescript
this.initBotPool().catch((err) =>
  logger.error({ err }, 'Telegram: pool init failed'),
);
```

Background — don't await; we don't want pool `getMe` round-trips to delay channel connect.

**4e. Update `registerChannel` factory.** At the bottom of the file:

```typescript
registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_POOL']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const poolRaw =
    process.env.TELEGRAM_BOT_POOL || envVars.TELEGRAM_BOT_POOL || '';
  const poolTokens = poolRaw.split(',').map((t) => t.trim()).filter(Boolean);
  return new TelegramChannel(token, opts, poolTokens);
});
```

### Step 5: Patch `src/ipc.ts`

If `add-slack-swarm` is already installed, only update the `sendPoolMessage` signature in `IpcDeps` to match Step 3. The swarm route in `processIpcFiles` is shared.

If swarm-routing isn't there yet, add it — see `add-slack-swarm` Step 5.

### Step 6: Patch `src/index.ts`

If `add-slack-swarm` is already installed, only update the `sendPoolMessage` callback in `startIpcWatcher` to forward `iconEmoji` and `threadId`. Otherwise add the full block — see `add-slack-swarm` Step 6.

### Step 7: Patch the MCP tool

If `add-slack-swarm` is already installed, the `icon_emoji` field is already added — no change. Otherwise see `add-slack-swarm` Step 4.

### Step 8: Update each Telegram group's `CLAUDE.md`

For every `groups/telegram_*/CLAUDE.md` you want teams enabled in (typically `telegram_main`), add an "Agent Teams (swarm)" section after "Sub-agents and teammates". Required content:

1. **Read `/workspace/global/memory/personas.md` first** — canonical roles + when-to-use. (`icon_emoji` is Slack-only — pass it if you want, ignored on Telegram.)
2. **Match the user's wording for `sender`.** Even if not a library role.
3. **Each teammate's prompt must include**: role/identity name, instruction to call `mcp__nanoclaw__send_message` with `sender: "<role>"`, terseness (2–4 sentences/call), Telegram formatting (single asterisks, underscores, • bullets, no `##` headings, no `[text](url)`), coordination via `SendMessage` (Task tool's reply channel) not `send_message` to the user group.
4. **Lead doesn't relay.** User sees teammate messages directly from the renamed pool bots.
5. **Pool size is finite.** Note the pool size in the rule. For teams larger than the pool, names will collide — keep teams ≤ pool size.

A reference snippet lives in this skill's repository copy of `groups/telegram_main/CLAUDE.md`.

### Step 9: Build, restart

```bash
npm run build
pm2 restart nanoclaw          # Windows / Linux
# launchctl unload + load ~/Library/LaunchAgents/com.nanoclaw.plist  # macOS
# systemctl --user restart nanoclaw  # Linux systemd
```

After restart, expect logs like:

```
Telegram pool bot initialized poolSize=1
Telegram pool bot initialized poolSize=2
Telegram pool bot initialized poolSize=3
Telegram bot pool ready count=3
```

If the count is less than your token list, one or more `getMe` calls failed — check the per-token error in the lines above.

## Testing

In a Telegram group with the pool bots and main bot all present: «собери команду из исследователя и инженера, спланируй маленький эксперимент по X». Expect:

1. Lead message from the main bot acknowledging.
2. Message from a pool bot now named `Researcher` (or whatever the user said).
3. Message from another pool bot now named `Coder`.
4. (If the chat has topics enabled and the conversation is in a topic) all of the above land in the same topic.
5. Lead's final synthesis from the main bot.

Watch logs:

```bash
tail -f data/nanoclaw.log | grep -iE "telegram pool|setMyName|sendPoolMessage"
```

## Architecture notes

- Pool bots use Grammy's `Api` class — lightweight, no polling, just send.
- `setMyName` is **global** to the bot, not per-chat. If two groups simultaneously assign the same pool bot to different roles, the most-recent rename wins for both. The `senderBotMap` keys by `{groupFolder}:{senderName}` so within a single group you're safe; across groups, parallel use can mix identities visually. Mitigation: separate pools per high-traffic group, or just live with it for low-frequency use.
- The 2-second sleep after `setMyName` is empirical — Telegram propagates name changes asynchronously. Without the wait the first message under the new identity sometimes still shows the old name to clients.
- Sender→bot mapping resets on service restart — this is intentional (clean slate avoids stale mappings).

## Troubleshooting

- **Pool bots don't send messages.** Verify each token: `curl -s "https://api.telegram.org/bot<TOKEN>/getMe"`. Check `grep "Pool bot" data/nanoclaw.log` for init errors. Ensure all pool bots are members of the target group, and Group Privacy is **disabled** for each (BotFather → Bot Settings → Group Privacy → Turn off).
- **Bot names don't update for users.** Telegram caches bot names client-side. The 2-second delay covers server-side propagation; client cache may need a force-refresh or even a Telegram restart for the user. After 1–2 normal messages the cache catches up.
- **Subagents don't call `send_message` with `sender`.** Lead isn't including the instruction in the teammate's spawn prompt. Re-read the group's `CLAUDE.md` Agent Teams section — the lead must be told that *each teammate's prompt includes the directive*. The lead doesn't pick this up by osmosis.
- **`MESSAGE_THREAD_NOT_FOUND` error.** Step 4c missed — the `^\d+$` integer check on `threadId`. Without it a Slack-style timestamp leaking across channels (rare but possible) crashes the send.
- **Pool count is less than expected** in logs. One or more tokens failed `getMe`. Likely an invalid/revoked token. Re-create that pool slot via BotFather.

## Removal

Revert each file from Step 3–8. Remove `TELEGRAM_BOT_POOL` from `.env` and `data/env/env`. Pool bots themselves can stay (or be deleted via `@BotFather` → `/deletebot`).
