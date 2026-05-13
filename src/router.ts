import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Structured metadata about what the agent is looking at in <messages>.
 * Encoded as attributes on the <context> tag so the agent has an
 * unambiguous, machine-readable signal — no more guessing whether the
 * visible thread is exhaustive or a slice.
 */
export interface ContextInfo {
  /** "thread" — triggered inside a Slack thread / Telegram topic.
   *  "root"   — triggered at channel root, last-N top-level messages.
   *  Omitted = no special hint (legacy). */
  mode?: 'thread' | 'root';

  /** Channel-native thread identifier. Only meaningful when mode='thread'. */
  threadId?: string;

  /** "full"  — <messages> contains the entire thread (parent + all replies).
   *  "delta" — <messages> contains only messages newer than the cursor;
   *            earlier thread context lives in the agent's prior turns. */
  injection?: 'full' | 'delta';

  /** True only when injection='full' AND the cap kicked in. The visible
   *  block has parent + most-recent replies; older middle messages dropped.
   *  When injection='delta' this always reads false (delta has no cap-on-
   *  first-turn semantics). */
  truncated?: boolean;

  /** Total messages currently in the thread. Lets the agent compare against
   *  what's visible. Optional. */
  totalThreadMessages?: number;

  /** Number of messages in the current <messages> block. Optional. */
  shown?: number;

  /** ISO timestamp the cursor was at before this turn — i.e. messages
   *  injected here are strictly newer than this. Only set when
   *  injection='delta'. Helps the agent place the delta in time. */
  since?: string;

  /** Channel-window size for mode='root'. Number of top-level messages. */
  channelWindow?: number;
}

export interface FormatMessagesOptions {
  context?: ContextInfo;
}

function renderContextTag(timezone: string, c?: ContextInfo): string {
  const attrs: string[] = [`timezone="${escapeXml(timezone)}"`];
  if (c?.mode) attrs.push(`mode="${c.mode}"`);
  if (c?.threadId) attrs.push(`thread_id="${escapeXml(c.threadId)}"`);
  if (c?.injection) attrs.push(`injection="${c.injection}"`);
  if (c?.truncated !== undefined) {
    attrs.push(`truncated="${c.truncated ? 'true' : 'false'}"`);
  }
  if (typeof c?.totalThreadMessages === 'number') {
    attrs.push(`total_thread_messages="${c.totalThreadMessages}"`);
  }
  if (typeof c?.shown === 'number') attrs.push(`shown="${c.shown}"`);
  if (c?.since) attrs.push(`since="${escapeXml(c.since)}"`);
  if (typeof c?.channelWindow === 'number') {
    attrs.push(`channel_window="${c.channelWindow}"`);
  }
  return `<context ${attrs.join(' ')} />\n`;
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  options: FormatMessagesOptions = {},
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const threadAttr = m.thread_id
      ? ` thread_ts="${escapeXml(m.thread_id)}"`
      : '';
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${threadAttr}${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = renderContextTag(timezone, options.context);
  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
