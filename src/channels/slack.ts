import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type { CanonicalReaction } from '../reactions/vocabulary.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Don't download files larger than this — keep container disks bounded.
const FILE_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB
// Inline text snippets up to this size in the message body; beyond this we
// still save the file to disk but embed only the path reference.
const SNIPPET_INLINE_LIMIT = 100 * 1024; // 100 KB

// Slack filetypes we treat as text (inline their content into the message).
// Covers snippets (what you get when someone pastes a table as a "snippet")
// and common source/data formats.
const TEXT_FILETYPES = new Set<string>([
  'text',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'toml',
  'markdown',
  'md',
  'html',
  'post',
  'javascript',
  'typescript',
  'python',
  'java',
  'ruby',
  'go',
  'rust',
  'shell',
  'bash',
  'sql',
  'diff',
  'patch',
  'log',
]);

// Slack's rich-text table block (composer UI: Tab key or /table).
// Appears in `msg.attachments[].blocks[]`, NOT in msg.text — so without
// explicit extraction, the bot never sees the table content.
interface SlackTableBlock {
  type: 'table';
  rows: SlackTableCell[][];
}
type SlackTableCell =
  | { type: 'raw_text'; text: string }
  | { type: 'rich_text'; elements?: unknown[] };

function extractRichText(elements: unknown[] | undefined): string {
  if (!Array.isArray(elements)) return '';
  const parts: string[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as { type?: string; text?: string; elements?: unknown[] };
    if (e.type === 'text' && typeof e.text === 'string') parts.push(e.text);
    else if (e.elements) parts.push(extractRichText(e.elements));
  }
  return parts.join('');
}

function cellToText(cell: SlackTableCell): string {
  if (cell.type === 'raw_text') return cell.text || '';
  if (cell.type === 'rich_text') return extractRichText(cell.elements);
  return '';
}

function tableToMarkdown(block: SlackTableBlock): string {
  const rows = block.rows.map((row) =>
    row.map((cell) => cellToText(cell).replace(/\|/g, '\\|').trim()),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  // Pad short rows so the markdown output is well-formed.
  const padded = rows.map((r) => {
    const out = [...r];
    while (out.length < width) out.push('');
    return out;
  });
  const header = `| ${padded[0].join(' | ')} |`;
  const sep = `| ${Array(width).fill('---').join(' | ')} |`;
  const body = padded.slice(1).map((r) => `| ${r.join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

/** Walk any block/attachment tree and return all tables rendered as markdown. */
function extractTables(msg: {
  blocks?: unknown[];
  attachments?: unknown[];
}): string[] {
  const out: string[] = [];
  const walk = (nodes: unknown[] | undefined): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const n = node as { type?: string; blocks?: unknown[] };
      if (n.type === 'table') {
        const md = tableToMarkdown(node as SlackTableBlock);
        if (md) out.push(md);
      }
      if (Array.isArray(n.blocks)) walk(n.blocks);
    }
  };
  walk(msg.blocks);
  walk(msg.attachments);
  return out;
}

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  // For small snippets, Slack may include content inline
  preview?: string;
}

function sanitizeFilename(name: string): string {
  // Strip anything that could escape the attachments dir; keep extension.
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function isTextFile(file: SlackFile): boolean {
  if (file.filetype && TEXT_FILETYPES.has(file.filetype)) return true;
  if (file.mimetype?.startsWith('text/')) return true;
  if (file.mimetype === 'application/json') return true;
  if (file.mimetype === 'application/xml') return true;
  return false;
}

function formatBytes(n: number | undefined): string {
  if (!n) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Canonical reaction → Slack shortcode. TypeScript enforces that every
// CanonicalReaction has an entry; adding a new canonical without updating
// this map fails the build.
const SLACK_SHORTCODE: Record<CanonicalReaction, string> = {
  saw: 'eyes',
  done: 'white_check_mark',
  cancel: 'x',
  working: 'muscle',
  searching: 'mag',
  writing: 'writing_hand',
  building: 'hammer',
  thinking: 'brain',
  reading: 'book',
  retrying: 'repeat',
};

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadId?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;
    this.botToken = botToken || '';

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
      // Capture our own outbound messages so PR 4's "show bot messages in
      // thread context" actually has data to show. Bolt defaults to true
      // and silently swallows every event whose user matches the bot —
      // even from app.event('message'), so the comment in setupEventHandlers
      // was mistaken about how to opt in. The trigger-detection path
      // filters by is_bot_message=0 in getMessagesSince, so re-entry loops
      // are still prevented.
      ignoreSelf: false,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We accept:
      //   - undefined subtype: regular message (may have files inline)
      //   - 'bot_message': track our own output
      //   - 'file_share': file upload with no text
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') {
        return;
      }

      const msg = event as HandledMessageEvent & {
        files?: SlackFile[];
        blocks?: unknown[];
        attachments?: unknown[];
      };

      // Skip only if there's nothing to process.
      if (
        !msg.text &&
        !msg.files?.length &&
        !msg.blocks?.length &&
        !msg.attachments?.length
      ) {
        return;
      }

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Build content: start with the user's text, then append:
      //   - markdown rendering of any rich-text table blocks (not in msg.text)
      //   - each file (inlined snippet content or saved-file reference)
      let content = msg.text || '';
      const tables = extractTables(msg);
      for (const md of tables) {
        content += (content ? '\n\n' : '') + `[Table]\n${md}`;
      }
      if (msg.files?.length) {
        for (const file of msg.files) {
          const block = await this.handleIncomingFile(file, group.folder);
          if (block) content += (content ? '\n\n' : '') + block;
        }
      }

      if (!content) return; // all files failed, nothing to deliver

      const threadId = msg.thread_ts || msg.ts;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_id: threadId,
      });
    });
  }

  /**
   * Download a Slack file (or inline small text snippets) and return a
   * content block for embedding in the message. Returns null if the file
   * can't be handled — never throws.
   */
  private async handleIncomingFile(
    file: SlackFile,
    groupFolder: string,
  ): Promise<string | null> {
    const name = file.name || file.title || `file-${file.id}`;
    const size = file.size ?? 0;

    if (size > FILE_SIZE_LIMIT) {
      logger.warn(
        { name, size, limit: FILE_SIZE_LIMIT },
        'Slack file too large, skipping download',
      );
      return `[File: ${name} — skipped, too large (${formatBytes(size)})]`;
    }

    const url = file.url_private_download || file.url_private;
    if (!url) {
      logger.warn({ name, id: file.id }, 'Slack file has no download URL');
      return `[File: ${name} — no download URL]`;
    }

    let buffer: Buffer;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      if (!resp.ok) {
        logger.warn(
          { name, status: resp.status },
          'Slack file download failed',
        );
        return `[File: ${name} — download failed (${resp.status})]`;
      }
      buffer = Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      logger.warn(
        { name, err: (err as Error).message },
        'Slack file download threw',
      );
      return `[File: ${name} — download error]`;
    }

    // Save to disk regardless — agent may want to open the file for richer
    // processing even if we also inline the text.
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const safeName = sanitizeFilename(name);
    const destPath = path.join(attachDir, safeName);
    try {
      fs.writeFileSync(destPath, buffer);
    } catch (err) {
      logger.warn(
        { name, err: (err as Error).message },
        'Failed to write Slack file to disk',
      );
      return `[File: ${name} — save failed]`;
    }
    const containerPath = `/workspace/group/attachments/${safeName}`;

    // Inline short text snippets directly so the agent sees the content
    // without opening the file. (This is the UX that was missing when you
    // posted a table as a Slack snippet and the bot ignored it.)
    if (isTextFile(file) && buffer.length <= SNIPPET_INLINE_LIMIT) {
      const text = buffer.toString('utf-8');
      const fence =
        file.filetype && file.filetype !== 'text' ? file.filetype : '';
      return `[File: ${name}] (${containerPath})\n\`\`\`${fence}\n${text}\n\`\`\``;
    }

    return `[File: ${name}] (${containerPath})`;
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup (non-blocking — don't hold up other channels)
    this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
    _replyToMessageId?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadId });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed.
      // We persist each chunk we successfully post so the bot's own thread
      // replies show up in messages.db — Slack's events echo for bot
      // messages is unreliable even with ignoreSelf:false, and we need
      // these rows for PR 4's "include bot messages in thread context".
      const persistOutbound = (ts: string | undefined, chunk: string): void => {
        if (!ts) return;
        const isoTs = new Date(parseFloat(ts) * 1000).toISOString();
        this.opts.onMessage(jid, {
          id: ts,
          chat_jid: jid,
          sender: this.botUserId || '',
          sender_name: ASSISTANT_NAME,
          content: chunk,
          timestamp: isoTs,
          is_from_me: true,
          is_bot_message: true,
          thread_id: threadId || ts,
        });
      };

      if (text.length <= MAX_MESSAGE_LENGTH) {
        const resp = await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadId ? { thread_ts: threadId } : {}),
        });
        persistOutbound(resp.ts, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          const chunk = text.slice(i, i + MAX_MESSAGE_LENGTH);
          const resp = await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            ...(threadId ? { thread_ts: threadId } : {}),
          });
          persistOutbound(resp.ts, chunk);
        }
      }
      logger.info({ jid, length: text.length, threadId }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadId });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  /**
   * Send a swarm message under a custom persona — different `username` and
   * `icon_emoji` per call. Slack handles this natively via chat.postMessage's
   * `username`/`icon_emoji` fields (requires the `chat:write.customize` scope
   * on the bot token). No bot pool is needed.
   */
  async sendPoolMessage(
    jid: string,
    text: string,
    sender: string,
    _groupFolder: string,
    iconEmoji?: string,
    threadId?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      // Fall back to regular queue with the sender prefixed into the text
      // so it isn't lost while we're offline.
      this.outgoingQueue.push({ jid, text: `[${sender}] ${text}`, threadId });
      logger.info(
        { jid, sender, queueSize: this.outgoingQueue.length },
        'Slack disconnected, swarm message queued (with sender prefix)',
      );
      return;
    }

    const personaOpts: {
      username: string;
      icon_emoji?: string;
      thread_ts?: string;
    } = {
      username: sender,
      ...(iconEmoji ? { icon_emoji: iconEmoji } : {}),
      ...(threadId ? { thread_ts: threadId } : {}),
    };

    try {
      const persistOutbound = (ts: string | undefined, chunk: string): void => {
        if (!ts) return;
        const isoTs = new Date(parseFloat(ts) * 1000).toISOString();
        this.opts.onMessage(jid, {
          id: ts,
          chat_jid: jid,
          sender: this.botUserId || '',
          sender_name: sender,
          content: chunk,
          timestamp: isoTs,
          is_from_me: true,
          is_bot_message: true,
          thread_id: threadId || ts,
        });
      };

      if (text.length <= MAX_MESSAGE_LENGTH) {
        const resp = await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...personaOpts,
        });
        persistOutbound(resp.ts, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          const chunk = text.slice(i, i + MAX_MESSAGE_LENGTH);
          const resp = await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            ...personaOpts,
          });
          persistOutbound(resp.ts, chunk);
        }
      }
      logger.info(
        { jid, sender, iconEmoji, threadId, length: text.length },
        'Slack pool message sent',
      );
    } catch (err) {
      logger.error(
        { jid, sender, err },
        'Failed to send Slack pool message',
      );
    }
  }

  /**
   * Delete a message via Slack chat.delete. Only works for messages the
   * bot itself sent (without admin scope). On failure, throws — caller
   * decides how to surface the error.
   */
  async deleteMessage(jid: string, messageId: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    await this.app.client.chat.delete({
      channel: channelId,
      ts: messageId,
    });
    logger.info({ jid, messageId }, 'Slack message deleted');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  supportsReactions(_jid: string): boolean {
    return this.connected;
  }

  async sendFile(
    jid: string,
    filePath: string,
    opts?: { caption?: string; threadId?: string },
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'Slack not connected, file send dropped');
      return;
    }
    const channelId = jid.replace(/^slack:/, '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadArgs: Record<string, any> = {
      channel_id: channelId,
      file: fs.createReadStream(filePath),
      filename: path.basename(filePath),
    };
    if (opts?.caption) uploadArgs.initial_comment = opts.caption;
    if (opts?.threadId) uploadArgs.thread_ts = opts.threadId;
    try {
      await this.app.client.files.uploadV2(uploadArgs as never);
      logger.info(
        { jid, filePath, threadId: opts?.threadId },
        'Slack file uploaded',
      );
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/missing_scope/i.test(msg)) {
        logger.warn(
          { jid, filePath },
          'Slack file upload failed: bot missing files:write scope',
        );
        return;
      }
      logger.warn({ jid, filePath, err: msg }, 'Slack file upload failed');
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    reaction: CanonicalReaction,
  ): Promise<void> {
    if (!this.connected) return;
    const channelId = jid.replace(/^slack:/, '');
    const name = SLACK_SHORTCODE[reaction];
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name,
      });
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/already_reacted/i.test(msg)) {
        logger.debug(
          { jid, messageId, reaction, name },
          'Slack reaction already present',
        );
        return;
      }
      if (/missing_scope/i.test(msg)) {
        logger.warn(
          { jid, messageId, reaction, name },
          'Slack reaction failed: bot missing reactions:write scope — add it in OAuth & Permissions and reinstall the app',
        );
        return;
      }
      if (/invalid_name/i.test(msg)) {
        logger.warn(
          { jid, messageId, reaction, name },
          'Slack reaction failed: shortcode not recognized in this workspace — pick a different canonical→shortcode mapping in src/channels/slack.ts',
        );
        return;
      }
      logger.warn(
        { jid, messageId, reaction, name, err: msg },
        'Slack addReaction failed',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(item.threadId ? { thread_ts: item.threadId } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length, threadId: item.threadId },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
