/**
 * Local embedding client + dedup cache.
 *
 * Talks to an OpenAI-compatible /v1/embeddings endpoint — by default the
 * LM Studio server at http://127.0.0.1:1234 with text-embedding-nomic-embed-text-v1.5@q8_0.
 * Local-first means no API key, no per-token cost, no network egress.
 *
 * Override via env:
 *   EMBEDDING_BASE_URL  — default http://127.0.0.1:1234/v1
 *   EMBEDDING_MODEL     — default text-embedding-nomic-embed-text-v1.5@q8_0
 *   EMBEDDING_API_KEY   — optional, default empty (local endpoints don't need it)
 *
 * Nomic Embed v1.5 outputs 768 dims natively. It is Matryoshka-trained, so
 * lower dims can be obtained client-side by truncate-then-L2-normalize. Most
 * memory work runs at 768 — storage is 3 KB/vector, fine at our scale.
 *
 * The dedup cache (sqlite at store/embedding_cache.db) hashes (model, dim,
 * text) → embedding so we don't re-embed identical content across restarts.
 */
import crypto from 'crypto';
import path from 'path';
import Database from 'better-sqlite3';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

const DEFAULT_BASE_URL =
  process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:1234/v1';
const DEFAULT_MODEL =
  process.env.EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5@q8_0';
const DEFAULT_DIM = parseInt(process.env.EMBEDDING_DIM || '768', 10);
const API_KEY = process.env.EMBEDDING_API_KEY || '';

const CACHE_DB_PATH = path.join(STORE_DIR, 'embedding_cache.db');

let cacheDb: Database.Database | null = null;

function getCacheDb(): Database.Database {
  if (cacheDb) return cacheDb;
  const db = new Database(CACHE_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  cacheDb = db;
  return db;
}

function hashKey(model: string, dim: number, text: string): string {
  return crypto
    .createHash('sha256')
    .update(`${model}:${dim}:${text}`)
    .digest('hex');
}

function vecToBlob(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    buf.writeFloatLE(v[i], i * 4);
  }
  return buf;
}

function blobToVec(buf: Buffer): number[] {
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

/** L2-normalize in place; returns the same array. */
function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Matryoshka-style truncation: take the first `dim` components and re-L2-normalize.
 * Only applied when caller asks for a dim smaller than what the server returned.
 */
function truncateToDim(v: number[], dim: number): number[] {
  if (v.length === dim) return v;
  if (v.length < dim) {
    throw new Error(
      `truncateToDim: cannot expand ${v.length} → ${dim}; reduce dim only`,
    );
  }
  return l2Normalize(v.slice(0, dim));
}

export interface EmbedOptions {
  model?: string;
  /** Output dim. Server's native dim is 768 for nomic-embed-v1.5. Smaller dims are truncate-then-L2-normalize (Matryoshka). */
  dim?: number;
  /** Hint for ordering models that distinguish (Voyage does, Nomic via prefix). Currently unused for the OpenAI-compatible endpoint. */
  inputType?: 'document' | 'query';
}

/**
 * Embed a list of strings. Returns same-length array of vectors. Hits the
 * persistent cache for (model, dim, text) tuples seen before.
 *
 * Throws on API error — callers should surface, not silently degrade.
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  const model = opts.model ?? DEFAULT_MODEL;
  const dim = opts.dim ?? DEFAULT_DIM;

  const db = getCacheDb();
  const getStmt = db.prepare(
    'SELECT vector FROM embedding_cache WHERE hash = ?',
  );
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, model, dim, vector, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const result = new Array<number[] | null>(texts.length).fill(null);
  const toEmbed: { idx: number; text: string; hash: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const h = hashKey(model, dim, text);
    const row = getStmt.get(h) as { vector: Buffer } | undefined;
    if (row) {
      result[i] = blobToVec(row.vector);
    } else {
      toEmbed.push({ idx: i, text, hash: h });
    }
  }

  if (toEmbed.length === 0) {
    return result as number[][];
  }

  // Many local servers cap concurrent requests; batches of 32 are well-behaved.
  const BATCH = 32;
  for (let start = 0; start < toEmbed.length; start += BATCH) {
    const batch = toEmbed.slice(start, start + BATCH);
    const body: Record<string, unknown> = {
      input: batch.map((b) => b.text),
      model,
    };
    const url = `${DEFAULT_BASE_URL.replace(/\/$/, '')}/embeddings`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Embeddings API ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    for (const item of data.data) {
      const b = batch[item.index];
      const truncated = truncateToDim(item.embedding, dim);
      result[b.idx] = truncated;
      const blob = vecToBlob(truncated);
      insertStmt.run(b.hash, model, dim, blob, new Date().toISOString());
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (!result[i]) {
      throw new Error(`embedTexts: missing embedding for index ${i}`);
    }
  }
  logger.debug(
    {
      n: texts.length,
      cached: texts.length - toEmbed.length,
      embedded: toEmbed.length,
      model,
      dim,
    },
    'embedTexts',
  );
  return result as number[][];
}

export async function embedOne(
  text: string,
  opts: EmbedOptions = {},
): Promise<number[]> {
  const [v] = await embedTexts([text], opts);
  return v;
}

export const EMBED_DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  dim: DEFAULT_DIM,
};
