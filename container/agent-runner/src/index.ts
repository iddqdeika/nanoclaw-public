/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  accumulateMessageUsage,
  emptyDedupe,
  emptyUsage as emptyUsageImpl,
  type DedupeState,
  type TurnUsage as TurnUsageType,
} from './usage.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  threadId?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: TurnUsage;
}

// TurnUsage and emptyUsage live in ./usage.ts so the dedupe accumulator
// can be unit-tested without spinning up an SDK iterator. Re-export the
// type locally so existing references in this file keep working.
type TurnUsage = TurnUsageType;
const emptyUsage = emptyUsageImpl;

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const trustLevel = process.env.NANOCLAW_TRUST_LEVEL || 'untrusted';

const TOOLS_BY_TRUST: Record<string, string[]> = {
  main: [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage', 'TodoWrite',
    'ToolSearch', 'Skill', 'NotebookEdit',
    'mcp__nanoclaw__*',
    // Explicit entries — wildcard above occasionally fails to resolve
    // specific tools at dispatch time (SDK/cache behaviour); naming
    // them removes the ambiguity.
    'mcp__nanoclaw__send_file',
    'mcp__nanoclaw__get_usage_metrics',
    'mcp__atlassian__*',
    'mcp__grafana__*', 'mcp__grafana2__*',
    'mcp__clickhouse__*', 'mcp__gitlab__*',
    'mcp__feeds__*',
    'mcp__playwright__*',
    // MCP Gateway A/B path — when MCP_GATEWAY_TOKEN is set, the gateway
    // shim replaces the 6 direct entries above and exposes meta-tools
    // plus dynamically-activated category tools.
    'mcp__gateway__*',
  ],
  trusted: [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
    'SendMessage', 'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
    'mcp__nanoclaw__*', 'mcp__nanoclaw__send_file',
    'mcp__atlassian__*',
    'mcp__grafana__*', 'mcp__grafana2__*',
    'mcp__clickhouse__*', 'mcp__gitlab__*',
    'mcp__feeds__*',
    'mcp__playwright__*',
    'mcp__gateway__*',
  ],
  untrusted: [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'SendMessage', 'ToolSearch', 'Skill',
    'mcp__nanoclaw__send_message', 'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__set_progress_reaction',
    'mcp__gateway__*',
  ],
};

// MCP Gateway A/B: presence of MCP_GATEWAY_TOKEN flips agent-runner from
// spawning direct credentialed MCPs to spawning a single gateway-client
// shim. Set per-container by container-runner when group.containerConfig
// .useMcpGateway is true. Unset → today's behaviour (direct spawns).
const useGateway = !!process.env.MCP_GATEWAY_TOKEN;

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// IPC task dir — matches ipc-mcp-stdio.ts. Used by agent-runner itself to
// emit out-of-band signals (e.g. model_exhausted on rate-limit failover).
const TASKS_DIR = '/workspace/ipc/tasks';

// Mirror of the in-flight turn usage so the SIGTERM handler can flush whatever
// was accumulated when docker sends us SIGTERM before the SDK produces a
// `result` event. Reset alongside the local `turnUsage` inside runQuery().
let activeTurnUsage: TurnUsage | null = null;
let activeTurnSessionId: string | undefined;
let sigtermFlushed = false;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

// Synchronous variant for signal handlers. console.log is piped/buffered on
// non-TTY stdout — a bufferedWrite followed by process.exit() can lose the
// payload. fs.writeSync to fd 1 bypasses the buffer.
function writeOutputSync(output: ContainerOutput): void {
  const payload =
    OUTPUT_START_MARKER +
    '\n' +
    JSON.stringify(output) +
    '\n' +
    OUTPUT_END_MARKER +
    '\n';
  try {
    fs.writeSync(1, payload);
  } catch {
    // last-resort; nothing we can do
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// Docker sends SIGTERM before SIGKILL on `docker stop`. Flush whatever
// partial usage we've accumulated in the current turn so the host can
// persist it to turn_metrics instead of losing it to the hard kill.
function installSigtermFlush(): void {
  const handler = (signal: NodeJS.Signals) => {
    if (sigtermFlushed) return;
    sigtermFlushed = true;
    if (activeTurnUsage && activeTurnUsage.api_call_count > 0) {
      writeOutputSync({
        status: 'error',
        result: null,
        newSessionId: activeTurnSessionId,
        error: `killed_by_${signal.toLowerCase()}`,
        usage: activeTurnUsage,
      });
      log(
        `Flushed partial usage on ${signal}: in:${activeTurnUsage.input_tokens}+cc:${activeTurnUsage.cache_creation_tokens}+cr:${activeTurnUsage.cache_read_tokens}+out:${activeTurnUsage.output_tokens} apis:${activeTurnUsage.api_call_count}`,
      );
    } else {
      log(`Received ${signal} with no in-flight turn usage to flush`);
    }
    // Exit with signal-encoded code so the host can distinguish graceful
    // stop from a crash. 143 == 128 + 15 (SIGTERM), 130 == 128 + 2 (SIGINT).
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      // Per-thread archives: when this session belongs to a thread,
      // file under conversations/threads/{thread_id}/. Plain channel-root
      // sessions stay flat at conversations/. The thread_id is sanitized
      // to be filesystem-safe (Slack ts strings are dot-and-digit, but
      // Telegram topic ids could be arbitrary).
      const rawThreadId = process.env.NANOCLAW_THREAD_ID || '';
      const threadIdSafe = rawThreadId.replace(/[^a-zA-Z0-9._-]/g, '_');
      const conversationsBase = '/workspace/group/conversations';
      const conversationsDir = threadIdSafe
        ? path.join(conversationsBase, 'threads', threadIdSafe)
        : conversationsBase;
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
interface RateLimitHit {
  model: string;
  resetsAt?: string; // ISO datetime
  rateLimitType?: string;
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  model: string | undefined,
  extraSystemPromptAppend: string | undefined,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  rateLimited?: RateLimitHit;
  outputEmitted: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let turnUsage: TurnUsage = emptyUsage();
  // Per-turn dedupe state: tracks the highest output_tokens seen per
  // assistant message id so we can take MAX-not-SUM across the SDK's
  // streaming-thinking + final-text emissions of the same response.
  let turnDedupe: DedupeState = emptyDedupe();
  // Expose the current turn's usage + session id so the SIGTERM handler can
  // flush whatever has accumulated if docker kills us mid-turn.
  activeTurnUsage = turnUsage;
  activeTurnSessionId = newSessionId;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  let rateLimited: RateLimitHit | undefined;
  let outputEmitted = false;

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      ...(model ? { model } : {}),
      systemPrompt: (() => {
        const parts = [globalClaudeMd, extraSystemPromptAppend].filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        );
        if (parts.length === 0) return undefined;
        return {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: parts.join('\n\n'),
        };
      })(),
      allowedTools: TOOLS_BY_TRUST[trustLevel] || TOOLS_BY_TRUST.untrusted,
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: (() => {
        const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              NANOCLAW_THREAD_ID: containerInput.threadId || '',
              NANOCLAW_TRUST_LEVEL: trustLevel,
            },
          },
        };
        if (trustLevel === 'main' || trustLevel === 'trusted') {
          servers.playwright = {
            command: 'playwright-mcp',
            args: [
              '--browser', 'chromium',
              '--executable-path', '/usr/bin/chromium',
              '--headless',
              '--isolated',
              '--no-sandbox',
            ],
            env: {},
          };
        }
        // Gateway is the only supported path for external MCPs. Register
        // additional MCPs via /add-mcp-to-gateway (edits groups/_gateway/acl.json).
        // Groups with useMcpGateway:false (legacy) get the built-in `nanoclaw`
        // MCP only — no external credentialed servers.
        if (useGateway) {
          const gatewayClientPath = path.join(
            path.dirname(mcpServerPath),
            'gateway-client.js',
          );
          servers.gateway = {
            command: 'node',
            args: [gatewayClientPath],
            env: {
              MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL || '',
              MCP_GATEWAY_TOKEN: process.env.MCP_GATEWAY_TOKEN || '',
              MCP_GATEWAY_GROUP: process.env.MCP_GATEWAY_GROUP || '',
            },
          };
        }
        return servers;
      })(),
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // Rate-limit detection: SDK emits a dedicated event before the API
    // actually refuses the call. When status === 'rejected', we're blocked.
    // Record the reset time (unix seconds → ISO) and bail out fast so the
    // caller can retry with the next model in the priority chain.
    if (message.type === 'rate_limit_event') {
      const info = (message as { rate_limit_info?: {
        status?: string;
        resetsAt?: number;
        rateLimitType?: string;
      } }).rate_limit_info;
      if (info && info.status === 'rejected') {
        let resetsAtIso: string | undefined;
        if (typeof info.resetsAt === 'number' && info.resetsAt > 0) {
          const ms = info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000;
          resetsAtIso = new Date(ms).toISOString();
        }
        rateLimited = {
          model: model || 'default',
          resetsAt: resetsAtIso,
          rateLimitType: info.rateLimitType,
        };
        log(
          `Rate-limit event (rejected): model=${model || 'default'} type=${info.rateLimitType || '?'} resetsAt=${resetsAtIso || '?'} — aborting stream`,
        );
        break;
      }
    }

    // Belt-and-braces detection: if the SDK doesn't emit rate_limit_event
    // and instead surfaces the limit as a result with text like "You've hit
    // your limit · resets 11pm (Europe/Moscow)", catch that too.
    if (
      !outputEmitted &&
      message.type === 'result' &&
      'result' in message &&
      typeof (message as { result?: string }).result === 'string'
    ) {
      const text = (message as { result: string }).result;
      const m = text.match(
        /hit your limit[^·]*(?:·|\|)\s*resets\s+(\d{1,2})(am|pm)(?:\s*\(([^)]+)\))?/i,
      );
      if (m) {
        let resetsAtIso: string | undefined;
        try {
          const hour12 = parseInt(m[1], 10);
          const hour24 =
            m[2].toLowerCase() === 'pm'
              ? hour12 === 12
                ? 12
                : hour12 + 12
              : hour12 === 12
                ? 0
                : hour12;
          const tz = m[3] || 'UTC';
          // Next occurrence of hour24 in tz — if already past today, assume tomorrow
          const now = new Date();
          const nowInTz = new Date(
            now.toLocaleString('en-US', { timeZone: tz }),
          );
          const reset = new Date(nowInTz);
          reset.setHours(hour24, 0, 0, 0);
          if (reset <= nowInTz) reset.setDate(reset.getDate() + 1);
          resetsAtIso = reset.toISOString();
        } catch {
          /* unparseable — leave undefined; host will fall back to a default TTL */
        }
        rateLimited = {
          model: model || 'default',
          resetsAt: resetsAtIso,
        };
        log(
          `Rate-limit detected via result text: model=${model || 'default'} resetsAt=${resetsAtIso || '?'} — aborting stream`,
        );
        break;
      }
    }

    // Accumulate per-turn usage. The SDK can emit two `assistant` events
    // with the same `message.id` for one streaming response — once for the
    // thinking phase, once for the final text. Both carry usage but the
    // values are NOT additive (we observed `output_tokens=14` for a 1475-
    // token reply). `accumulateMessageUsage` dedupes by message id so the
    // running totals match what the JSONL records as the final state.
    if (message.type === 'assistant') {
      const m = (message as { message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
        content?: Array<{ type?: string; name?: string }>;
      } }).message;
      if (m) {
        const toolUseNames: string[] = [];
        for (const block of m.content ?? []) {
          if (block.type === 'tool_use' && block.name) {
            toolUseNames.push(block.name);
          }
        }
        accumulateMessageUsage(turnUsage, turnDedupe, {
          messageId: m.id,
          model: m.model,
          input_tokens: m.usage?.input_tokens,
          cache_creation_input_tokens: m.usage?.cache_creation_input_tokens,
          cache_read_input_tokens: m.usage?.cache_read_input_tokens,
          output_tokens: m.usage?.output_tokens,
          // tool_use blocks are deduped via message id too — only counted
          // on the FIRST emission of a given message.
          toolUseNames: m.id && turnDedupe.countedMessages.has(m.id)
            ? []
            : toolUseNames,
        });
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      activeTurnSessionId = newSessionId;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''} tokens=in:${turnUsage.input_tokens}+cc:${turnUsage.cache_creation_tokens}+cr:${turnUsage.cache_read_tokens}+out:${turnUsage.output_tokens} tools=${turnUsage.tool_call_count}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        usage: turnUsage,
      });
      if (textResult) outputEmitted = true;
      turnUsage = emptyUsage();
      turnDedupe = emptyDedupe();
      activeTurnUsage = turnUsage;
    }
  }

  // Query completed cleanly — nothing to flush on any subsequent SIGTERM.
  activeTurnUsage = null;
  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}${rateLimited ? `, rateLimited=${rateLimited.model}` : ''}`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    rateLimited,
    outputEmitted,
  };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  installSigtermFlush();
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Fallback model chain. The FIRST attempt uses whatever model the SDK
  // picks by default (typically Sonnet) — no explicit override — so we
  // don't cut across whatever Anthropic tunes as the current best default.
  // Only on rate-limit failover do we start passing explicit models from
  // this chain. Host has already filtered out models known to be
  // exhausted before handing this env to us.
  const fallbackChain = (process.env.NANOCLAW_MODEL_PRIORITY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Tell the host that a model is exhausted so the NEXT container spawn
  // picks a non-exhausted one at the outset instead of burning a retry.
  const emitModelExhausted = (hit: RateLimitHit) => {
    try {
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(TASKS_DIR, filename);
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      const tmp = `${filepath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          type: 'model_exhausted',
          model: hit.model,
          resets_at: hit.resetsAt,
          rate_limit_type: hit.rateLimitType,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        }),
      );
      fs.renameSync(tmp, filepath);
    } catch (err) {
      log(
        `Failed to emit model_exhausted IPC: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Query loop: run query → wait for IPC message → run new query → repeat.
  // currentModel=undefined means "let the SDK pick" (first attempt). On
  // rate-limit failover, currentModel switches to an entry from
  // fallbackChain. fallbackIdx tracks how deep into the chain we are:
  //   -1 = haven't failed over yet (SDK default in use)
  //   0..N-1 = using fallbackChain[i]
  let resumeAt: string | undefined;
  let fallbackIdx = -1;
  let currentModel: string | undefined;
  let lastRateLimit: RateLimitHit | undefined;

  const buildDegradedNotice = (): string | undefined => {
    if (fallbackIdx < 0) return undefined;
    const resets = lastRateLimit?.resetsAt ?? 'unknown';
    return [
      '<degraded_mode>',
      `The primary model is rate-limited (resets ${resets}). You are running on a FALLBACK model (${currentModel || 'unknown'}) with reduced capability and limited remaining quota.`,
      '',
      'Follow this degraded-mode policy for this turn:',
      '',
      `- ALWAYS start your reply with a brief one-line disclaimer on its own line, e.g. "⚠️ Fallback model (${currentModel || 'unknown'}); primary resets ${resets}." Then continue with the actual reply.`,
      '- Handle only simple, directly-typed requests (short factual answers, trivial edits, clear confirmations).',
      '- If the user asks for complex or ambiguous work (research, multi-step tool use, long reasoning, code generation) — DO NOT attempt it. Reply briefly that the primary model is rate-limited and offer to do it after the reset time.',
      '- If you were about to run scheduled or queued tasks, PROPOSE POSTPONING them until the primary model is back.',
      '- Keep replies terse.',
      '- Do not silently degrade quality — if you skip something, say so explicitly and name the reset time.',
      '- Never guess or make assumptions when unsure. If the task depends on something you are not certain about (names, IDs, behavior, data), STOP and ask the user to confirm or clarify — do not fabricate. Fallback models are more likely to hallucinate; be extra cautious here.',
      "- Reply in the user's language. If the user writes in Russian, reply in Russian (including the disclaimer line). Match whatever language the incoming message uses.",
      '</degraded_mode>',
    ].join('\n');
  };

  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, model: ${currentModel || 'SDK-default'}, resumeAt: ${resumeAt || 'latest'}${fallbackIdx >= 0 ? ', degraded-mode' : ''})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        currentModel,
        buildDegradedNotice(),
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Rate-limit failover: abort this attempt, escalate to the next
      // model in the fallback chain. Only retry if no user-facing output
      // has been emitted yet — mid-turn retries would produce confusing
      // duplicate replies.
      if (queryResult.rateLimited) {
        lastRateLimit = queryResult.rateLimited;
        emitModelExhausted(queryResult.rateLimited);
        const nextIdx = fallbackIdx + 1;
        if (!queryResult.outputEmitted && nextIdx < fallbackChain.length) {
          fallbackIdx = nextIdx;
          const nextModel = fallbackChain[fallbackIdx];
          log(
            `Retrying with fallback model: ${currentModel || 'SDK-default'} → ${nextModel} (resets ${queryResult.rateLimited.resetsAt || '?'})`,
          );
          currentModel = nextModel;
          continue;
        }
        // Either we've already streamed output, or all fallbacks exhausted.
        const exhausted = nextIdx >= fallbackChain.length;
        const msg = exhausted
          ? `All fallback models exhausted (last: ${currentModel || 'SDK-default'}, resets ${queryResult.rateLimited.resetsAt || '?'}). Try again later.`
          : `Rate-limited mid-turn on ${currentModel || 'SDK-default'} (resets ${queryResult.rateLimited.resetsAt || '?'}); partial output kept. Retry for the remainder.`;
        log(msg);
        writeOutput({ status: 'error', result: msg });
        break;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
