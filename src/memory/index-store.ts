/**
 * V2 chunk-based LanceDB store. Replaces V1 store.ts.
 *
 * Each record is a chunk of a real markdown file on disk. The full set is
 * rebuildable by running the indexer over source files — no blackbox rows.
 *
 * See docs/MEMORY-V2-PLAN.md for architecture.
 */
import path from 'path';
import fs from 'fs';
import * as lancedb from '@lancedb/lancedb';
import type { Table, Connection } from '@lancedb/lancedb';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { embedOne, EMBED_DEFAULTS } from './embed.js';

const TABLE_NAME = 'chunks';
const MEMORY_ROOT = path.join(DATA_DIR, 'memory');

export type MemoryTier = 'main' | 'trusted' | 'untrusted';
export type MemoryScope = 'group' | 'global';

export interface ChunkRecord {
  chunk_id: string; // sha256 prefix of (groupFolder:filePath:chunkIndex)
  file_path: string; // absolute host path
  chunk_index: number; // 0-based position within file
  line_start: number; // 1-based
  line_end: number; // 1-based
  content: string;
  scope: MemoryScope;
  domains: string; // JSON array e.g. '["research"]' or '[]'
  source_mtime: number; // epoch ms at index time
  source_sha256: string; // SHA-256 hex of full file content at index time
}

export interface ChunkHit extends ChunkRecord {
  score: number; // cosine similarity 0..1, higher = more relevant
}

export interface ChunkSearchOptions {
  k?: number;
  scope?: MemoryScope | MemoryScope[];
}

interface StoreHandle {
  groupFolder: string;
  conn: Connection;
  table: Table | null;
}

const handles = new Map<string, StoreHandle>();

function storeDir(groupFolder: string): string {
  return path.join(MEMORY_ROOT, groupFolder);
}

async function getOrOpen(groupFolder: string): Promise<StoreHandle> {
  let h = handles.get(groupFolder);
  if (h) return h;
  const dir = storeDir(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const conn = await lancedb.connect(dir);
  h = { groupFolder, conn, table: null };
  handles.set(groupFolder, h);
  return h;
}

async function openTable(handle: StoreHandle): Promise<Table | null> {
  if (handle.table) return handle.table;
  const names = await handle.conn.tableNames();
  if (names.includes(TABLE_NAME)) {
    handle.table = await handle.conn.openTable(TABLE_NAME);
    return handle.table;
  }
  return null;
}

function toRow(rec: ChunkRecord, vec: number[]): Record<string, unknown> {
  const embedding = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) embedding[i] = vec[i];
  return { ...rec, embedding };
}

function fromRow(row: Record<string, unknown>): ChunkRecord {
  return {
    chunk_id: String(row.chunk_id),
    file_path: String(row.file_path),
    chunk_index: Number(row.chunk_index),
    line_start: Number(row.line_start),
    line_end: Number(row.line_end),
    content: String(row.content),
    scope: row.scope as MemoryScope,
    domains: String(row.domains),
    source_mtime: Number(row.source_mtime),
    source_sha256: String(row.source_sha256),
  };
}

/**
 * Write chunks for one file. Deletes all existing chunks for that file_path
 * first, then inserts the new set atomically (delete + add).
 * Caller provides embeddings aligned by index with records.
 */
export async function upsertFileChunks(
  groupFolder: string,
  records: ChunkRecord[],
  embeddings: number[][],
): Promise<void> {
  if (records.length === 0) return;
  const handle = await getOrOpen(groupFolder);
  const filePath = records[0].file_path;
  const rows = records.map((r, i) => toRow(r, embeddings[i]));

  let table = await openTable(handle);
  if (!table) {
    table = await handle.conn.createTable(TABLE_NAME, rows);
    handle.table = table;
  } else {
    const safe = filePath.replace(/'/g, "''");
    await table.delete(`file_path = '${safe}'`);
    await table.add(rows);
  }
  logger.debug(
    { groupFolder, filePath, n: records.length },
    'memory: upsertFileChunks',
  );
}

/**
 * Delete all chunks for a file (call when a source file is removed).
 */
export async function deleteFileChunks(
  groupFolder: string,
  filePath: string,
): Promise<void> {
  const handle = await getOrOpen(groupFolder);
  const table = await openTable(handle);
  if (!table) return;
  const safe = filePath.replace(/'/g, "''");
  await table.delete(`file_path = '${safe}'`);
}

/**
 * Returns file_path → source_sha256 for all indexed files.
 * Used by partial reindex to skip unchanged files.
 */
export async function getFileChecksums(
  groupFolder: string,
): Promise<Map<string, string>> {
  const handle = await getOrOpen(groupFolder);
  const table = await openTable(handle);
  if (!table) return new Map();
  const rows = await table
    .query()
    .select(['file_path', 'source_sha256'])
    .toArray();
  const map = new Map<string, string>();
  for (const row of rows) {
    const fp = String(row.file_path);
    if (!map.has(fp)) map.set(fp, String(row.source_sha256));
  }
  return map;
}

/**
 * Vector search. Returns top-k chunks by cosine similarity.
 */
export async function searchChunks(
  groupFolder: string,
  query: string,
  opts: ChunkSearchOptions = {},
): Promise<ChunkHit[]> {
  const handle = await getOrOpen(groupFolder);
  const table = await openTable(handle);
  if (!table) return [];

  const k = opts.k ?? 10;
  const queryVec = await embedOne(query, { inputType: 'query' });
  const queryArr = new Float32Array(queryVec.length);
  for (let i = 0; i < queryVec.length; i++) queryArr[i] = queryVec[i];

  const filters: string[] = [];
  if (opts.scope) {
    const scopes = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
    const sList = scopes.map((s) => `'${s}'`).join(', ');
    filters.push(`scope IN (${sList})`);
  }

  let q = table.search(queryArr).limit(k);
  if (filters.length > 0) q = q.where(filters.join(' AND '));

  const rows = (await q.toArray()) as Array<
    Record<string, unknown> & { _distance: number }
  >;

  return rows.map((row) => {
    const rec = fromRow(row);
    const dist = Number(row._distance);
    // LanceDB L2 distance → cosine: cos = 1 - dist²/2 (for L2-normalized vectors)
    const score = Math.max(-1, Math.min(1, 1 - (dist * dist) / 2));
    return { ...rec, score };
  });
}

export async function countChunks(groupFolder: string): Promise<number> {
  const handle = await getOrOpen(groupFolder);
  const table = await openTable(handle);
  if (!table) return 0;
  return table.countRows();
}

export function _resetHandles(): void {
  handles.clear();
}

export const STORE_DEFAULTS = {
  embedDim: EMBED_DEFAULTS.dim,
  embedModel: EMBED_DEFAULTS.model,
  storeRoot: MEMORY_ROOT,
};
