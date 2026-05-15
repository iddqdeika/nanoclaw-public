/**
 * Per-turn memory prefill — runs a chunk search against the latest user
 * message and returns a `<recall>...</recall>` block to prepend to the prompt.
 *
 * The block goes at the prompt tail so the cached prefix (system + CLAUDE.md +
 * prior turns) is untouched — no cache_creation re-pay.
 *
 * Empty store, embedding endpoint down, or no hits above threshold → returns
 * ''. Never throws — prefill is best-effort.
 *
 * Turn-level hits are appended to data/memory/prefill-log.jsonl for analysis.
 */
import fs from 'fs';
import path from 'path';
import {
  searchChunks,
  type MemoryScope,
  type MemoryTier,
} from './index-store.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

export interface PrefillOptions {
  k?: number;
  minScore?: number;
  /** Max chars from any single chunk's content (truncated with ellipsis). */
  contentTrunc?: number;
}

const DEFAULT_K = 8;
const DEFAULT_MIN_SCORE = 0.55;
const DEFAULT_TRUNC = 500;

const PREFILL_LOG = path.join(DATA_DIR, 'memory', 'prefill-log.jsonl');

function scopesForTier(tier: MemoryTier): MemoryScope[] {
  if (tier === 'untrusted') return ['group'];
  return ['group', 'global'];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function displayPath(filePath: string): string {
  const rel = path.relative(GROUPS_DIR, filePath).replace(/\\/g, '/');
  return rel.startsWith('..') ? filePath : rel;
}

function logTurn(entry: object): void {
  fs.appendFile(PREFILL_LOG, JSON.stringify(entry) + '\n', (err) => {
    if (err)
      logger.warn(
        { err: (err as Error).message },
        'prefill-log: append failed',
      );
  });
}

/**
 * Run a chunk search against the query. Returns a `<recall>` block, or '' if
 * there are no good hits or the store is unavailable.
 */
export async function buildRecallBlock(
  groupFolder: string,
  tier: MemoryTier,
  query: string,
  opts: PrefillOptions = {},
): Promise<string> {
  const k = opts.k ?? DEFAULT_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const trunc = opts.contentTrunc ?? DEFAULT_TRUNC;

  if (!query.trim()) return '';

  let hits;
  try {
    hits = await searchChunks(groupFolder, query, {
      k,
      scope: scopesForTier(tier),
    });
  } catch (err) {
    logger.warn(
      { groupFolder, err: (err as Error).message },
      'memory prefill: search failed, skipping',
    );
    return '';
  }

  const filtered = hits.filter((h) => h.score >= minScore);

  logTurn({
    ts: Date.now(),
    group: groupFolder,
    tier,
    query_prefix: query.slice(0, 80),
    k,
    min_score: minScore,
    n_hits_raw: hits.length,
    n_hits_filtered: filtered.length,
    had_recall: filtered.length > 0,
    hits: filtered.map((h) => ({
      file: displayPath(h.file_path),
      line_start: h.line_start,
      line_end: h.line_end,
      score: parseFloat(h.score.toFixed(3)),
      scope: h.scope,
    })),
  });

  if (filtered.length === 0) return '';

  const lines: string[] = ['<recall>'];
  for (const h of filtered) {
    const loc = `${displayPath(h.file_path)}:${h.line_start}-${h.line_end}`;
    lines.push(`[${h.score.toFixed(2)} ${h.scope}] ${loc}`);
    lines.push(truncate(h.content, trunc));
    lines.push('');
  }
  lines.push('</recall>');
  lines.push('');
  return lines.join('\n');
}
