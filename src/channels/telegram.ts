import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import type { CanonicalReaction } from '../reactions/vocabulary.js';

// Canonical reaction → Telegram Unicode emoji. Every entry must be in the
// Telegram Bot API's allowed reaction set for free bots — if Telegram adds
// or changes the allowed set, update the substitutions here.
// TypeScript enforces that every CanonicalReaction has an entry.
const TELEGRAM_EMOJI: Record<CanonicalReaction, string> = {
  saw: '👀',
  done: '👍', // ✅ not in allowed set
  cancel: '👎', // ❌ not in allowed set
  working: '🫡', // "on it" — 💪 not in allowed set
  searching: '🤔', // 🔍 not in allowed set
  writing: '✍️',
  building: '⚡', // 🔨 not in allowed set
  thinking: '🤯', // 🧠 not in allowed set
  reading: '🤓', // 📖 not in allowed set
  retrying: '🔥', // 🔁 not in allowed set
};

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<Awaited<ReturnType<Api['sendMessage']>>> {
  try {
    return await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    return await api.sendMessage(chatId, text, options);
  }
}

// Auto-recovery tuning
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000; // 5 min cap
const HEALTH_CHECK_INTERVAL_MS = 60_000; // ping getMe every minute
const HEALTH_CHECK_FAILURES_BEFORE_RESTART = 3;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private reconnectAttempt = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckFailures = 0;
  private shuttingDown = false;
  private restartScheduled = false;

  // Bot pool for agent teams (swarm). Send-only Api instances — no polling.
  // Each pool bot is renamed at first use to match a sender role, then sticks
  // to that role within the group for the rest of the orchestrator's uptime.
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

  /**
   * Schedule a bot restart after a failure, with exponential backoff.
   * Coalesces multiple concurrent failure signals into a single restart.
   */
  private scheduleRestart(reason: string): void {
    if (this.shuttingDown || this.restartScheduled) return;
    this.restartScheduled = true;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt++;

    logger.warn(
      { reason, delayMs: delay, attempt: this.reconnectAttempt },
      'Telegram: scheduling bot restart',
    );

    setTimeout(() => {
      this.restartScheduled = false;
      this.restartBot(reason).catch((err) =>
        logger.error({ err }, 'Telegram restart failed'),
      );
    }, delay);
  }

  /** Stop the current bot and start a fresh one. */
  private async restartBot(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    logger.info({ reason }, 'Telegram: restarting bot');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.bot) {
      try {
        await this.bot.stop();
      } catch (err) {
        logger.warn({ err }, 'Telegram: stop during restart failed (ignoring)');
      }
      this.bot = null;
    }

    try {
      await this.connect();
      this.healthCheckFailures = 0;
      logger.info('Telegram: bot restarted successfully');
      // Reset backoff only after bot stays stable for 5 min — otherwise
      // transient failures reset the counter and we never back off enough
      const stabilityTimer = setTimeout(() => {
        if (this.bot && !this.shuttingDown) {
          this.reconnectAttempt = 0;
          logger.info('Telegram: bot stable, backoff reset');
        }
      }, 5 * 60_000);
      stabilityTimer.unref?.();
    } catch (err) {
      logger.error({ err }, 'Telegram: restart connect failed');
      this.scheduleRestart('reconnect failed');
    }
  }

  /**
   * Periodic health check — calls getMe() to verify the bot is reachable.
   * If it fails N times in a row, trigger a restart.
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(async () => {
      if (!this.bot || this.shuttingDown) return;
      try {
        await this.bot.api.getMe();
        this.healthCheckFailures = 0;
      } catch (err) {
        this.healthCheckFailures++;
        logger.warn(
          {
            err: (err as Error).message,
            failures: this.healthCheckFailures,
          },
          'Telegram: health check failed',
        );
        if (this.healthCheckFailures >= HEALTH_CHECK_FAILURES_BEFORE_RESTART) {
          this.scheduleRestart('health check failures');
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully — detect fatal vs recoverable errors
    this.bot.catch((err) => {
      const msg = err.message || String(err);
      logger.error({ err: msg }, 'Telegram bot error');

      // 401 = invalid bot token, fatal — don't restart
      if (/401|unauthorized/i.test(msg)) {
        logger.fatal(
          { err: msg },
          'Telegram: bot token invalid, not restarting',
        );
        return;
      }

      // 409 = another instance polling. Schedule restart with delay so the
      // other instance times out before we re-claim the connection.
      if (/409|conflict|terminated by other/i.test(msg)) {
        this.scheduleRestart('409 Conflict');
        return;
      }

      // Network errors, 5xx — Grammy auto-retries, but if we see persistent
      // errors the health check will catch it and trigger restart
    });

    // Start polling — returns a Promise that resolves when started.
    // Run start() in the background so its rejection doesn't crash the host.
    // Capture the bot reference so when restartBot() replaces this.bot,
    // the old start()'s resolution doesn't trigger another restart.
    const capturedBot = this.bot;
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          logger.info(
            { hint: `/chatid → get chat registration ID` },
            `Telegram bot: @${botInfo.username}`,
          );
          this.startHealthCheck();
          // Initialize swarm pool bots (no-op when none configured or
          // already initialized). Done in background — we don't block
          // the channel's connect() on pool bot getMe() calls.
          this.initBotPool().catch((err) =>
            logger.error({ err }, 'Telegram: pool init failed'),
          );
          resolved = true;
          resolve();
        },
      })
        .then(() => {
          // start() resolves when polling stops. Only restart if:
          //   1. We got past onStart (resolved) — not an early failure
          //   2. Not shutting down
          //   3. This bot is still the "current" one — if restartBot replaced
          //      it, don't double-restart
          if (resolved && !this.shuttingDown && this.bot === capturedBot) {
            logger.warn('Telegram: polling loop exited unexpectedly');
            this.scheduleRestart('polling loop exited');
          }
        })
        .catch((err) => {
          logger.error({ err: err.message }, 'Telegram bot.start() failed');
          if (!resolved) {
            reject(err);
          } else if (!this.shuttingDown && this.bot === capturedBot) {
            this.scheduleRestart('start() rejected');
          }
        });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
    _replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      // See sendPoolMessage: only honour threadId when it's a clean integer
      // (Telegram topic ids), otherwise drop to avoid MESSAGE_THREAD_NOT_FOUND
      // when a Slack-style "12345.6789" timestamp leaks across channels or
      // when the Telegram chat doesn't have topics enabled.
      const options =
        threadId && /^\d+$/.test(threadId)
          ? { message_thread_id: parseInt(threadId, 10) }
          : {};

      // Persist each chunk we successfully send into messages.db. Telegram
      // does not echo a bot's own messages back via getUpdates, so the only
      // way to record them is here at the send call site. Required for
      // PR 4's "include bot messages in thread context" to actually have
      // data on Telegram.
      const persistOutbound = (
        msg: Awaited<ReturnType<Api['sendMessage']>>,
        chunk: string,
      ): void => {
        const sentAt = msg.date
          ? new Date(msg.date * 1000).toISOString()
          : new Date().toISOString();
        const threadIdOut = msg.message_thread_id
          ? msg.message_thread_id.toString()
          : threadId || undefined;
        this.opts.onMessage(jid, {
          id: msg.message_id.toString(),
          chat_jid: jid,
          sender: msg.from?.id?.toString() || '',
          sender_name: ASSISTANT_NAME,
          content: chunk,
          timestamp: sentAt,
          is_from_me: true,
          is_bot_message: true,
          thread_id: threadIdOut,
        });
      };

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        const sent = await sendTelegramMessage(
          this.bot.api,
          numericId,
          text,
          options,
        );
        persistOutbound(sent, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          const sent = await sendTelegramMessage(
            this.bot.api,
            numericId,
            chunk,
            options,
          );
          persistOutbound(sent, chunk);
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Initialize send-only Api instances for the pool of swarm bots. Called
   * from connect() once the main bot is up. Idempotent — re-calling on
   * reconnect is safe because the existing Api instances are still valid.
   */
  private async initBotPool(): Promise<void> {
    if (this.poolTokens.length === 0 || this.poolApis.length > 0) return;
    for (const token of this.poolTokens) {
      try {
        const api = new Api(token);
        const me = await api.getMe();
        this.poolApis.push(api);
        logger.info(
          {
            username: me.username,
            id: me.id,
            poolSize: this.poolApis.length,
          },
          'Telegram pool bot initialized',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to initialize Telegram pool bot');
      }
    }
    if (this.poolApis.length > 0) {
      logger.info(
        { count: this.poolApis.length },
        'Telegram bot pool ready',
      );
    }
  }

  /**
   * Send a message via a pool bot assigned to the given sender name. On
   * first use of (groupFolder, sender) the bot is renamed via setMyName
   * to match the sender's role; subsequent messages from the same sender
   * in the same group reuse the same bot. Falls back to the main bot if
   * no pool is configured.
   */
  async sendPoolMessage(
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
    _iconEmoji?: string,
    threadId?: string,
  ): Promise<void> {
    // _iconEmoji is Slack-only; Telegram identifies the persona via the
    // pool bot's setMyName call and has no per-message avatar concept.
    if (this.poolApis.length === 0) {
      // No pool configured — fall back to the main bot
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
        // Telegram needs a moment to propagate the name change before the
        // first message under the new identity is delivered to clients.
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
      // Only pass message_thread_id when threadId is a clean integer string.
      // Slack thread timestamps look like "1717842000.012345" and parseInt
      // would silently truncate them to a junk topic id that Telegram
      // rejects with MESSAGE_THREAD_NOT_FOUND. Non-topic Telegram chats
      // also reject any thread_id, so when in doubt — drop it.
      const options =
        threadId && /^\d+$/.test(threadId)
          ? { message_thread_id: parseInt(threadId, 10) }
          : {};
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, sender, poolIndex: idx, threadId, length: text.length },
        'Telegram pool message sent',
      );
    } catch (err) {
      logger.error(
        { jid, sender, err },
        'Failed to send Telegram pool message',
      );
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    opts?: { caption?: string; threadId?: string },
  ): Promise<void> {
    if (!this.bot) {
      logger.warn({ jid, filePath }, 'Telegram bot not initialized');
      return;
    }
    const chatId = Number(jid.replace(/^tg:/, ''));
    const input = new InputFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isPhoto = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    const other: Record<string, unknown> = {};
    if (opts?.caption) other.caption = opts.caption;
    if (opts?.threadId) {
      const n = parseInt(opts.threadId, 10);
      if (Number.isFinite(n)) other.message_thread_id = n;
    }
    try {
      if (isPhoto) {
        await this.bot.api.sendPhoto(chatId, input, other);
      } else {
        await this.bot.api.sendDocument(chatId, input, other);
      }
      logger.info({ jid, filePath, asPhoto: isPhoto }, 'Telegram file sent');
    } catch (err) {
      logger.warn(
        { jid, filePath, err: (err as Error).message },
        'Telegram file send failed',
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  supportsReactions(jid: string): boolean {
    if (!this.bot) return false;
    // Bot reactions only work in groups/supergroups/channels (negative IDs),
    // not in private 1:1 chats (positive IDs).
    const id = Number(jid.replace(/^tg:/, ''));
    return Number.isFinite(id) && id < 0;
  }

  async addReaction(
    jid: string,
    messageId: string,
    reaction: CanonicalReaction,
  ): Promise<void> {
    if (!this.bot || !this.supportsReactions(jid)) return;
    const unicode = TELEGRAM_EMOJI[reaction];
    try {
      const chatId = Number(jid.replace(/^tg:/, ''));
      const msgId = Number(messageId);
      // setMessageReaction replaces the bot's reaction set per call — native swap.
      await this.bot.api.setMessageReaction(chatId, msgId, [
        { type: 'emoji', emoji: unicode as any },
      ]);
    } catch (err) {
      logger.warn(
        { jid, messageId, reaction, unicode, err: (err as Error).message },
        'Telegram addReaction failed',
      );
    }
  }
}

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
  const poolTokens = poolRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return new TelegramChannel(token, opts, poolTokens);
});
