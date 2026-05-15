import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Rate-limit failover for agent containers.
 *
 * The FIRST attempt of any turn uses whatever model the Claude Agent SDK
 * picks by default (typically Sonnet). If that attempt hits a rate limit,
 * the agent-runner falls back through this chain in order. We do NOT
 * override the SDK default up-front — we only supply explicit models for
 * retries.
 *
 * `NANOCLAW_MODEL_PRIORITY` (env) overrides the default chain. Format:
 * comma-separated model IDs, fallback order. Do not include the SDK
 * default model in the chain — it's already the first attempt.
 *
 * Exhaustion state lives on disk at `store/model-exhaustion.json` so it
 * survives container + orchestrator restarts. `markExhausted` is called
 * by the `model_exhausted` IPC handler; `getFallbackChain` filters
 * exhausted entries out before the next container spawn.
 */

const EXHAUSTION_FILE = path.join(STORE_DIR, 'model-exhaustion.json');

export const DEFAULT_FALLBACK_CHAIN = ['claude-haiku-4-5', 'claude-opus-4-7'];

function rawChain(): string[] {
  const env = process.env.NANOCLAW_MODEL_PRIORITY;
  if (!env) return DEFAULT_FALLBACK_CHAIN;
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type ExhaustionMap = Record<string, string | null>;

function readExhaustion(): ExhaustionMap {
  try {
    return JSON.parse(
      fs.readFileSync(EXHAUSTION_FILE, 'utf-8'),
    ) as ExhaustionMap;
  } catch {
    return {};
  }
}

function writeExhaustion(m: ExhaustionMap): void {
  try {
    fs.mkdirSync(path.dirname(EXHAUSTION_FILE), { recursive: true });
    fs.writeFileSync(EXHAUSTION_FILE, JSON.stringify(m, null, 2));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Failed to write model-exhaustion.json',
    );
  }
}

export function markExhausted(model: string, resetsAt: string | null): void {
  const m = readExhaustion();
  m[model] = resetsAt;
  writeExhaustion(m);
  logger.warn({ model, resetsAt }, 'Model marked exhausted');
}

function isExhausted(model: string, map: ExhaustionMap, now: number): boolean {
  const until = map[model];
  if (!until) return false;
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs) || untilMs <= now) return false;
  return true;
}

/**
 * Build the fallback chain for a new container spawn.
 * Reads the configured priority, drops models we know are still
 * rate-limited. Auto-clears expired entries as a side-effect.
 */
export function getFallbackChain(): string[] {
  const list = rawChain();
  const map = readExhaustion();
  const now = Date.now();
  let mutated = false;
  const keep: string[] = [];
  for (const model of list) {
    const until = map[model];
    if (!until) {
      keep.push(model);
      continue;
    }
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs) || untilMs <= now) {
      // Expired — clear in-place and include in the chain.
      map[model] = null;
      mutated = true;
      keep.push(model);
    }
    // else: still exhausted; skip.
  }
  if (mutated) writeExhaustion(map);
  return keep;
}

export function getExhaustionSnapshot(): ExhaustionMap {
  return readExhaustion();
}
