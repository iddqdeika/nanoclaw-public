import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  MCP_GATEWAY_PORT,
  ONESHOT_DEFAULT_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { startMcpGateway } from './mcp-gateway/index.js';
import { setGatewayInstance } from './mcp-gateway/instance.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  getTrustLevel,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
  stopContainer,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getRootMessagesSince,
  getSessionLastSeen,
  getThreadMessages,
  getThreadMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  sessionKey,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setSessionLastSeen,
  clearSessionLastSeen,
  storeChatMetadata,
  storeMessage,
  writeTurnMetrics,
  // Recovery state
  markTurnInFlight,
  scheduleRetry,
  clearRecoveryState,
  getRecoveryStateForTurn,
} from './db.js';
import { classifyError, ErrorType } from './error-classifier.js';
import {
  computeNextRetry,
  shouldInjectRetryContext,
} from './retry-policy.js';
import {
  runRecoveryBootHook,
  startRecoverySweep,
} from './recovery-sweep.js';
import { consumeFailureSimulation } from './failure-simulator.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { loadRules } from './rules-loader.js';
import { startIpcWatcher } from './ipc.js';
import { applyReaction as setProgressReaction } from './progress-reactions.js';
import type { AgentReaction } from './reactions/vocabulary.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { rotateIfPoisoned } from './session-rotate.js';
import { buildRecallBlock } from './memory/prefill.js';
import { type MemoryTier } from './memory/index-store.js';
import { startupReindex } from './memory/indexer.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Consecutive-thrash counter per chat. Bumped when a turn's result text
// begins with "Autocompact is thrashing"; reset on any non-thrash result
// with real text. After the threshold, the circuit breaker trips (session
// dropped, cursor advanced, retries suppressed).
const thrashCounters = new Map<string, number>();
const THRASH_BREAKER_THRESHOLD = 2;
const THRASH_PREFIX = 'Autocompact is thrashing';

// Tracks the currently-processing trigger message per chat. Used by:
//   - set_progress_reaction MCP tool, to react on the current turn's message
//   - sendMessage thread routing, so replies go to the thread where the
//     latest trigger lives (not the original turn's thread, which matters
//     when messages get piped into an already-running container)
interface ActiveTurn {
  channel: Channel;
  messageId: string;
  threadId?: string;
  startedAt: string; // ISO — when this turn was dispatched (for duration_ms)
  groupFolder: string;
  sessionIdAtStart?: string; // sessions[group.folder] snapshot at dispatch
}
const activeTurns = new Map<string, ActiveTurn>();

export function getActiveTurn(chatJid: string): ActiveTurn | undefined {
  return activeTurns.get(chatJid);
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.
  // Template selection by trust level: main → main, trusted → global,
  // untrusted → untrusted (security-restricted template).
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const groupTrust = getTrustLevel(group);
    const templateName =
      groupTrust === 'main'
        ? 'main'
        : groupTrust === 'trusted'
          ? 'global'
          : 'untrusted';
    let templateFile = path.join(GROUPS_DIR, templateName, 'CLAUDE.md');
    // Fallback to global if untrusted template missing
    if (!fs.existsSync(templateFile)) {
      templateFile = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    }
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Seed mcp-secrets.json for main/trusted groups so external MCPs have
  // credentials immediately after registration/promotion. Copies from any
  // existing main group's folder. Only writes if the target doesn't already
  // have its own file — never overwrites intentional per-group overrides.
  const groupTrustLevel = getTrustLevel(group);
  const secretsFile = path.join(groupDir, 'mcp-secrets.json');
  if (
    (groupTrustLevel === 'main' || groupTrustLevel === 'trusted') &&
    !fs.existsSync(secretsFile)
  ) {
    const sourceMainGroup = Object.values(registeredGroups).find(
      (g) => g.isMain && g.folder !== group.folder,
    );
    if (sourceMainGroup) {
      const sourceSecrets = path.join(
        GROUPS_DIR,
        sourceMainGroup.folder,
        'mcp-secrets.json',
      );
      if (fs.existsSync(sourceSecrets)) {
        try {
          fs.copyFileSync(sourceSecrets, secretsFile);
          logger.info(
            { folder: group.folder, sourceFolder: sourceMainGroup.folder },
            'Seeded mcp-secrets.json from main group',
          );
        } catch (err) {
          logger.warn(
            { folder: group.folder, err },
            'Failed to seed mcp-secrets.json',
          );
        }
      }
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder, trust: groupTrustLevel },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return;

  // Determine thread context: reply in the thread where the bot was addressed.
  let triggerThreadId: string | undefined;
  let triggerMessageId: string | undefined;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return;

    // Use the last trigger message's thread context
    const lastTrigger = [...missedMessages]
      .reverse()
      .find(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
    triggerThreadId = lastTrigger?.thread_id;
    triggerMessageId = lastTrigger?.id;
  } else {
    // Main group / no-trigger: use the last message's thread context
    triggerThreadId = missedMessages[missedMessages.length - 1]?.thread_id;
    triggerMessageId = missedMessages[missedMessages.length - 1]?.id;
  }

  // Decide context scope based on whether the trigger sits inside a real
  // thread (i.e. it's a reply, not a top-level message that just happens to
  // start its own thread).
  //
  // Slack/Telegram top-level messages have thread_id === id. Real thread
  // replies have thread_id !== id, pointing at the parent. Legacy messages
  // (or non-threading channels) have thread_id null.
  const isThreadTrigger =
    !!triggerThreadId &&
    !!triggerMessageId &&
    triggerThreadId !== triggerMessageId;

  let baseMessages: NewMessage[];
  let contextInfo: import('./router.js').ContextInfo | undefined;

  if (isThreadTrigger) {
    // Thread trigger. First time we enter this thread (no cursor) we inject
    // the whole thread; on every subsequent turn we inject only messages
    // newer than what the SDK has already seen. The bot's own replies are
    // included in both fetches (PR 4) so a session-rotation event keeps the
    // visible thread coherent. Cumulative payload across turns ≈ thread
    // length, not thread_length × turn_count.
    const lastSeen = getSessionLastSeen(group.folder, triggerThreadId);
    const thread = lastSeen
      ? getThreadMessagesSince(
          chatJid,
          triggerThreadId as string,
          lastSeen,
          ASSISTANT_NAME,
        )
      : getThreadMessages(chatJid, triggerThreadId as string, ASSISTANT_NAME);
    baseMessages =
      thread.messages.length > 0 ? thread.messages : missedMessages;
    // Advance the cursor past the latest injected message so the next turn
    // only sees what comes after. Empty string is preserved if we somehow
    // injected nothing — never moves backwards.
    if (baseMessages.length > 0) {
      const latest = baseMessages[baseMessages.length - 1].timestamp;
      if (latest && latest > lastSeen) {
        setSessionLastSeen(group.folder, triggerThreadId, latest);
      }
    }
    // Total thread size for the agent's awareness — on delta turns the
    // injected slice is just what's new, but the agent should know the
    // cumulative thread size so it can decide whether to call get_thread
    // (it shouldn't, since prior turns already carry the earlier history).
    const fullThread = getThreadMessages(
      chatJid,
      triggerThreadId as string,
      ASSISTANT_NAME,
    );
    contextInfo = {
      mode: 'thread',
      threadId: triggerThreadId,
      injection: lastSeen ? 'delta' : 'full',
      truncated: lastSeen ? false : thread.truncated,
      totalThreadMessages: fullThread.totalCount,
      shown: baseMessages.length,
      ...(lastSeen ? { since: lastSeen } : {}),
    };
  } else {
    // Top-level (root) trigger. Use a per-session cursor (last_seen_ts on
    // the (folder, '') sessions row) so root mode behaves symmetric to
    // PR 5's thread mode: first turn injects the last-N channel window,
    // subsequent turns inject only the delta. When the session is dropped
    // (rotateIfPoisoned, thrash circuit-breaker, stale-session detection)
    // the row is removed, the cursor is gone, and the next turn re-injects
    // the full last-N window — critical for non-threading channels (Telegram
    // DMs, basic Telegram groups) where there is no thread context to lean
    // on after a session drop.
    const rootLastSeen = getSessionLastSeen(group.folder, '');
    const rootOnly = getRootMessagesSince(
      chatJid,
      rootLastSeen,
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    baseMessages = rootOnly.length > 0 ? rootOnly : missedMessages;
    if (baseMessages.length > 0) {
      const latest = baseMessages[baseMessages.length - 1].timestamp;
      if (latest && latest > rootLastSeen) {
        setSessionLastSeen(group.folder, '', latest);
      }
    }
    // No `injection` attribute for root mode — by construction, root
    // <messages> is ALWAYS a bounded window of the channel-root history,
    // never exhaustive. Re-using thread-mode's `injection="full"` would
    // mean different things in the two modes ("all of the thread" vs
    // "just refilled the channel-window cap"), which is exactly the
    // confusion the agent doesn't need. The `since` attribute (only set
    // on delta turns) plus shown vs channel_window is enough signal.
    contextInfo = {
      mode: 'root',
      channelWindow: MAX_MESSAGES_PER_PROMPT,
      shown: baseMessages.length,
      ...(rootLastSeen ? { since: rootLastSeen } : {}),
    };
  }

  const formattedPrompt = formatMessages(baseMessages, TIMEZONE, {
    context: contextInfo,
  });

  // Per-turn memory prefill: search the memory store with the latest user
  // message as the query, prepend top-K hits as a <recall> block. Goes at
  // the prompt tail so the cached prefix is preserved (no cache_creation
  // re-pay). Best-effort — empty store / endpoint down → no block, no error.
  // See docs/MEMORY-AMPLIFICATION-RESEARCH.md Round 2 Question 2.
  let recallBlock = '';
  const latestUserText = (() => {
    for (let i = baseMessages.length - 1; i >= 0; i--) {
      const m = baseMessages[i];
      if (!m.is_from_me && !m.is_bot_message) return m.content;
    }
    return '';
  })();
  if (latestUserText) {
    const tier: MemoryTier = group.isMain
      ? 'main'
      : group.containerConfig?.trusted
        ? 'trusted'
        : 'untrusted';
    // Untrusted: skip recall entirely. The semantic index covers global
    // memory across groups; surfacing hits to an untrusted-tier agent would
    // exfiltrate cross-group info the agent isn't supposed to see (and
    // mirrors what we did for the /workspace/global mount in
    // container-runner.ts). See rules/untrusted/global-memory-isolation.md.
    if (tier === 'untrusted') {
      recallBlock = '';
    } else {
      try {
        recallBlock = await buildRecallBlock(
          group.folder,
          tier,
          latestUserText,
        );
      } catch (err) {
        logger.warn(
          { group: group.folder, err: (err as Error).message },
          'prefill: recall build threw — skipping',
        );
        recallBlock = '';
      }
    }
  }
  // Recovery: if this is a retry attempt for crash / idle_timeout, prepend
  // a <retry_context> block so the agent knows previous attempt died and
  // can be defensive. For environmental errors (network/5xx/rate_limit/auth)
  // the agent's behaviour shouldn't change — those aren't its problem.
  const recoveryRow = getRecoveryStateForTurn(group.folder, triggerThreadId);
  let retryContextPrefix = '';
  if (
    recoveryRow &&
    shouldInjectRetryContext(recoveryRow.last_error_type as ErrorType)
  ) {
    retryContextPrefix =
      `<retry_context>\n` +
      `Previous attempt at this turn failed: error=${recoveryRow.last_error_type}\n` +
      `attempt: ${recoveryRow.attempt_count + 1}\n` +
      `details: ${recoveryRow.last_error_details || '(no details)'}\n\n` +
      `Be defensive this round:\n` +
      `• For idle_timeout: split long work into shorter pieces, use schedule_task for anything > 5min, emit send_message progress every few minutes so the watchdog doesn't reap you again.\n` +
      `• For crash: review what you were doing in the previous attempt's conversation history; check for infinite loops, huge memory allocations, recursive tool calls.\n` +
      `</retry_context>\n\n`;
  }

  const prompt = retryContextPrefix + recallBlock + formattedPrompt;

  // Mark this turn as in-flight in the recovery state. Stable
  // pending_since_message_id anchor for the cancel-reaction on eventual
  // give-up; clears on clean exit.
  if (triggerMessageId) {
    markTurnInFlight(group.folder, triggerThreadId || '', triggerMessageId);
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let circuitBreakerTripped = false;
  let lastErrorOutput: ContainerOutput | null = null;

  if (triggerMessageId) {
    activeTurns.set(chatJid, {
      channel,
      messageId: triggerMessageId,
      threadId: triggerThreadId,
      startedAt: new Date().toISOString(),
      groupFolder: group.folder,
      sessionIdAtStart: sessions[sessionKey(group.folder, triggerThreadId)],
    });
    // Stage 1: orchestrator saw the message
    void setProgressReaction(channel, chatJid, triggerMessageId, 'saw');
  }

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    triggerThreadId,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);

        // Thrash circuit breaker: count consecutive "Autocompact is thrashing"
        // results per chat. A bloated session resumes, autocompact thrashes
        // instead of processing input, the SDK returns success with the
        // thrash text — and does so again on retry. After the threshold we
        // drop the session, advance cursor past the poisoned messages, and
        // post one notice instead of burning more tokens.
        const isThrash = text.startsWith(THRASH_PREFIX);
        if (isThrash) {
          const n = (thrashCounters.get(chatJid) ?? 0) + 1;
          thrashCounters.set(chatJid, n);
          if (n >= THRASH_BREAKER_THRESHOLD) {
            circuitBreakerTripped = true;
            thrashCounters.delete(chatJid);
            logger.error(
              { group: group.name, consecutive: n },
              'Thrash circuit breaker tripped — dropping session, suppressing retries',
            );
            const breakerThreadId =
              activeTurns.get(chatJid)?.threadId ?? triggerThreadId;
            const breakerSessionKey = sessionKey(group.folder, breakerThreadId);
            if (sessions[breakerSessionKey]) {
              delete sessions[breakerSessionKey];
              deleteSession(group.folder, breakerThreadId);
            }
            const replyThreadId = breakerThreadId;
            const notice =
              `⚠️ Detected ${n} consecutive autocompact-thrash results. ` +
              `Rotated session and stopped retrying this message batch to ` +
              `avoid burning more tokens. Send a fresh message to continue.`;
            try {
              await channel.sendMessage(chatJid, notice, replyThreadId);
            } catch (err) {
              logger.warn(
                { err: (err as Error).message },
                'circuit-breaker notice send failed',
              );
            }
            outputSentToUser = true;
            resetIdleTimer();
            return;
          }
        } else if (text) {
          // Any non-thrash result with real text clears the streak.
          thrashCounters.delete(chatJid);
        }

        if (text) {
          // Reply into the CURRENT active turn's thread — not the original
          // turn's closure-captured triggerThreadId, which would be wrong
          // for messages piped into a running container.
          const replyThreadId =
            activeTurns.get(chatJid)?.threadId ?? triggerThreadId;
          await channel.sendMessage(chatJid, text, replyThreadId);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success' || result.status === 'error') {
        // Look up the CURRENT active turn — it may have been updated by
        // a subsequent message piped into this same container session.
        const turn = activeTurns.get(chatJid);
        if (result.status === 'success') queue.notifyIdle(chatJid);
        if (result.status === 'error') {
          hadError = true;
          // Capture the failed container output for the Layer 3 classifier
          // to inspect after runAgent returns. The classifier needs
          // exitCode/killedByTimeout/stderr to categorize correctly.
          lastErrorOutput = result;
        }
        if (turn) {
          const stage = result.status === 'success' ? 'done' : 'cancel';
          void setProgressReaction(
            turn.channel,
            chatJid,
            turn.messageId,
            stage,
          );
          // Persist per-turn metrics. Usage may be absent on non-model
          // result events (e.g. session-update markers) — skip those.
          if (result.usage) {
            const endedAt = new Date().toISOString();
            try {
              const avgContext =
                result.usage.api_call_count > 0
                  ? Math.round(
                      result.usage.sum_context_tokens /
                        result.usage.api_call_count,
                    )
                  : 0;
              writeTurnMetrics({
                group_folder: turn.groupFolder,
                chat_jid: chatJid,
                session_id:
                  sessions[sessionKey(turn.groupFolder, turn.threadId)] ||
                  turn.sessionIdAtStart ||
                  null,
                trigger_message_id: turn.messageId,
                model: result.usage.model,
                started_at: turn.startedAt,
                ended_at: endedAt,
                duration_ms:
                  Date.parse(endedAt) - Date.parse(turn.startedAt) || 0,
                status: result.status,
                input_tokens: result.usage.input_tokens,
                cache_creation_tokens: result.usage.cache_creation_tokens,
                cache_read_tokens: result.usage.cache_read_tokens,
                output_tokens: result.usage.output_tokens,
                tool_call_count: result.usage.tool_call_count,
                tool_calls_json: JSON.stringify(result.usage.tool_calls),
                max_context_tokens: result.usage.max_context_tokens,
                avg_context_tokens: avgContext,
                api_call_count: result.usage.api_call_count,
                // Recovery system tracks retry count per (group, thread) on
                // the sessions row (`attempt_count`). The legacy per-group
                // queue-level retry counter was removed when Layer 3 took
                // over. If you need attempt-count visibility per turn,
                // join turn_metrics on sessions.attempt_count by group_folder.
                retry_count: 0,
              });
            } catch (err) {
              logger.warn(
                { err: (err as Error).message },
                'writeTurnMetrics failed (non-fatal)',
              );
            }
          }
          // Don't delete activeTurns here — the agent's set_progress_reaction
          // IPC can arrive a second or two after success. New turns overwrite.
        }
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Safety net: if runAgent returned without any terminal signal via
  // onOutput (container died silently), fire one on whatever turn is
  // still marked active.
  const leftover = activeTurns.get(chatJid);
  if (leftover) {
    const terminal: 'done' | 'cancel' =
      output === 'error' || hadError ? 'cancel' : 'done';
    void setProgressReaction(
      leftover.channel,
      chatJid,
      leftover.messageId,
      terminal,
    );
  }
  activeTurns.delete(chatJid);

  if (output === 'error' || hadError) {
    // Circuit breaker trumps all other retry paths: session is rotated, one
    // notice was posted, cursor stays advanced so the same poisoned batch
    // cannot re-trigger on a fresh incoming message.
    if (circuitBreakerTripped) {
      logger.warn(
        { group: group.name },
        'Thrash circuit breaker tripped — not retrying this batch',
      );
      clearRecoveryState(group.folder, triggerThreadId || '');
      return;
    }
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      clearRecoveryState(group.folder, triggerThreadId || '');
      return;
    }

    // Layer 3 recovery: classify the error and either schedule a retry
    // (sweep loop / next user input picks it up) or give up cleanly.
    const err = lastErrorOutput as ContainerOutput | null;
    const classified = classifyError({
      exitCode: err?.exitCode ?? null,
      killedByTimeout: err?.killedByTimeout ?? false,
      stderr: err?.stderr ?? '',
      stdout: err?.error ?? '',
    });
    const recoveryRow = getRecoveryStateForTurn(group.folder, triggerThreadId);
    const attemptCount = (recoveryRow?.attempt_count ?? 0) + 1;
    const turnStartedAt = recoveryRow?.in_flight_since
      ? new Date(recoveryRow.in_flight_since)
      : new Date();
    const policy = computeNextRetry({
      errorType: classified.type,
      attemptCount,
      startedAt: turnStartedAt,
      resetsAt: classified.resets_at,
    });
    if (policy.nextRetryAt) {
      scheduleRetry(
        group.folder,
        triggerThreadId || '',
        policy.nextRetryAt.toISOString(),
        attemptCount,
        classified.type,
        classified.description,
      );
      logger.info(
        {
          group: group.name,
          threadId: triggerThreadId,
          errorType: classified.type,
          attemptCount,
          nextRetryAt: policy.nextRetryAt.toISOString(),
        },
        'Recovery: error scheduled for retry',
      );
      // Roll back cursor so the next retry (sweep- or user-triggered)
      // re-processes the same batch.
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      // Suppress in-process Layer 2 fast-retry loop — sweep owns the
      // schedule now. Return true so group-queue doesn't burn 3
      // immediate attempts (which would all hit the same outage).
      return;
    }

    // Budget exhausted — final give-up.
    const anchorMessageId =
      recoveryRow?.pending_since_message_id || triggerMessageId || null;
    logger.error(
      {
        group: group.name,
        errorType: classified.type,
        attemptCount,
        anchorMessageId,
        reason: policy.giveUpReason,
      },
      'Recovery: budget exhausted, giving up',
    );
    const replyThreadId =
      activeTurns.get(chatJid)?.threadId ?? triggerThreadId;
    try {
      await channel.sendMessage(
        chatJid,
        `❌ Не справился восстановиться. Причина: ${classified.description}. ` +
          `${policy.giveUpReason ? `(${policy.giveUpReason})` : ''} ` +
          `Попробуй снова если ещё актуально.`,
        replyThreadId,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'recovery give-up notice send failed',
      );
    }
    if (anchorMessageId && channel.addReaction) {
      try {
        await channel.addReaction(chatJid, anchorMessageId, 'cancel');
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'recovery give-up cancel reaction failed',
        );
      }
    }
    clearRecoveryState(group.folder, triggerThreadId || '');
    return;
  }

  // Success — clear any prior recovery state for this (group, thread).
  clearRecoveryState(group.folder, triggerThreadId || '');
  return;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  threadId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sKey = sessionKey(group.folder, threadId);
  let sessionId: string | undefined = sessions[sKey];

  // Failure simulation harness: if an admin-armed sim is queued for this
  // group, short-circuit and synthesize the error. Lets recovery testing
  // run without real outages.
  const simOutput = consumeFailureSimulation(group.folder);
  if (simOutput) {
    if (onOutput) {
      try {
        await onOutput(simOutput);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'simulated-failure onOutput threw',
        );
      }
    }
    return 'error';
  }

  // Autocompact-thrash guard: a session JSONL that has grown past the size
  // cap will almost certainly re-fill the context window on resume before
  // any new input is processed. Rotate it aside and start fresh. Past
  // conversations are already preserved in groups/<folder>/conversations/.
  if (sessionId && rotateIfPoisoned(group.folder, sessionId)) {
    delete sessions[sKey];
    deleteSession(group.folder, threadId);
    sessionId = undefined;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sKey] = output.newSessionId;
          setSession(group.folder, threadId, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const rules = loadRules(getTrustLevel(group));
    const finalPrompt = rules
      ? `<system_rules>\n${rules}\n</system_rules>\n\n${prompt}`
      : prompt;

    const output = await runContainerAgent(
      group,
      {
        prompt: finalPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        threadId,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sKey] = output.newSessionId;
      setSession(group.folder, threadId, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[sKey];
        deleteSession(group.folder, threadId);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();

            // Pipe path: update the active turn with the latest trigger
            // message's id AND thread so (a) `saw` reacts on the right
            // message, (b) sendMessage replies into the right thread.
            let pipeTrigger: { id: string; thread_id?: string } | undefined;
            if (needsTrigger) {
              const triggerPattern = getTriggerPattern(group.trigger);
              const allowlistCfg = loadSenderAllowlist();
              const lastTrigger = [...groupMessages]
                .reverse()
                .find(
                  (m) =>
                    triggerPattern.test(m.content.trim()) &&
                    (m.is_from_me ||
                      isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
                );
              if (lastTrigger) {
                pipeTrigger = {
                  id: lastTrigger.id,
                  thread_id: lastTrigger.thread_id,
                };
              }
            } else {
              const last = groupMessages[groupMessages.length - 1];
              if (last)
                pipeTrigger = { id: last.id, thread_id: last.thread_id };
            }
            if (pipeTrigger) {
              activeTurns.set(chatJid, {
                channel,
                messageId: pipeTrigger.id,
                threadId: pipeTrigger.thread_id,
                startedAt: new Date().toISOString(),
                groupFolder: group.folder,
                sessionIdAtStart:
                  sessions[sessionKey(group.folder, pipeTrigger.thread_id)],
              });
              void setProgressReaction(channel, chatJid, pipeTrigger.id, 'saw');
            }

            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start MCP gateway (used by groups with containerConfig.useMcpGateway).
  // Bound to PROXY_BIND_HOST so containers can reach it via host gateway.
  // Failure here is non-fatal — groups not using the gateway are unaffected,
  // and groups that opt in fall back to direct MCPs (with a warning) if the
  // gateway instance singleton is null.
  let gatewayInstance: Awaited<ReturnType<typeof startMcpGateway>> | null =
    null;
  try {
    gatewayInstance = await startMcpGateway({
      port: MCP_GATEWAY_PORT,
      bindHost: PROXY_BIND_HOST,
    });
    setGatewayInstance(gatewayInstance);
  } catch (err) {
    logger.error(
      { err },
      'mcp-gateway failed to start; A/B groups will fall back',
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    if (gatewayInstance) {
      try {
        await gatewayInstance.close();
      } catch (err) {
        logger.warn({ err }, 'mcp-gateway: error during shutdown');
      }
      setGatewayInstance(null);
    }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Recovery boot hook — find any in-flight rows left over from a previous
  // orchestrator instance (pm2 restart, crash) and schedule them for
  // immediate retry. Sweep loop below will pick them up.
  runRecoveryBootHook();

  // Recovery sweep loop — every minute, scan for sessions where
  // next_retry_at <= now and enqueue a message check for each. The standard
  // processGroupMessages path runs with the original cursor (rolled back on
  // failure), naturally coalescing any newer messages.
  startRecoverySweep({
    triggerReplay: async (row) => {
      // Find the group's chatJid by folder.
      const target = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === row.group_folder,
      );
      if (!target) {
        logger.warn(
          { folder: row.group_folder },
          'recovery sweep: no registered group for folder, skipping',
        );
        return;
      }
      const [chatJid] = target;
      logger.info(
        {
          folder: row.group_folder,
          threadId: row.thread_id,
          errorType: row.last_error_type,
          attemptCount: row.attempt_count,
        },
        'recovery sweep: enqueueing replay',
      );
      queue.enqueueMessageCheck(chatJid);
    },
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text, threadId);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, threadId);
    },
    sendPoolMessage: async (
      jid,
      text,
      sender,
      groupFolder,
      iconEmoji,
      threadId,
    ) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Channel doesn't support swarm — fall back to a tagged regular send
      // so the sender identity is at least visible in the message text.
      if (!channel.sendPoolMessage) {
        await channel.sendMessage(jid, `[${sender}] ${text}`, threadId);
        return;
      }
      await channel.sendPoolMessage(
        jid,
        text,
        sender,
        groupFolder,
        iconEmoji,
        threadId,
      );
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    sendFile: async (
      jid: string,
      filePath: string,
      opts?: { caption?: string; threadId?: string },
    ) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendFile) {
        throw new Error(`Channel for ${jid} does not support sendFile`);
      }
      await channel.sendFile(jid, filePath, opts);
    },
    deleteMessage: async (jid: string, messageId: string) => {
      const channel = findChannel(channels, jid);
      if (!channel?.deleteMessage) {
        throw new Error(`Channel for ${jid} does not support deleteMessage`);
      }
      await channel.deleteMessage(jid, messageId);
    },
    reactToActiveTurn: async (sourceGroup: string, reaction: AgentReaction) => {
      let matched = 0;
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder !== sourceGroup) continue;
        const turn = activeTurns.get(jid);
        if (!turn) {
          logger.warn(
            { sourceGroup, jid, reaction },
            'set_progress_reaction: no active turn for jid — reaction dropped',
          );
          continue;
        }
        matched++;
        logger.info(
          { sourceGroup, jid, messageId: turn.messageId, reaction },
          'set_progress_reaction: applying',
        );
        await setProgressReaction(turn.channel, jid, turn.messageId, reaction);
      }
      if (matched === 0) {
        logger.warn(
          {
            sourceGroup,
            reaction,
            activeTurnKeys: [...activeTurns.keys()],
          },
          'set_progress_reaction: no matching group+turn found',
        );
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startupReindex(Object.values(registeredGroups));
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
