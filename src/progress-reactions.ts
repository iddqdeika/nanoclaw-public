import { PROGRESS_REACTIONS_ENABLED } from './config.js';
import { logger } from './logger.js';
import type { CanonicalReaction } from './reactions/vocabulary.js';
import { Channel } from './types.js';

export async function applyReaction(
  channel: Channel | undefined,
  jid: string,
  messageId: string | undefined,
  reaction: CanonicalReaction,
): Promise<void> {
  if (!PROGRESS_REACTIONS_ENABLED) return;
  if (!channel || !messageId) return;
  if (!channel.addReaction) return;
  if (channel.supportsReactions && !channel.supportsReactions(jid)) return;
  try {
    await channel.addReaction(jid, messageId, reaction);
  } catch (err) {
    logger.debug(
      { jid, messageId, reaction, err: (err as Error).message },
      'progress reaction failed (non-fatal)',
    );
  }
}
