/**
 * Memory indexer — walks source files, chunks them, embeds, and upserts into
 * the per-group LanceDB store.
 *
 * Entry points:
 *   reindexGroup(groupFolder, opts)  — reindex one group (startup or manual)
 *   startupReindex(groups)           — fire-and-forget at service start
 *
 * Partial reindex (partial=true, default):
 *   For each file, mtime is the cheap pre-check; SHA-256 is the authoritative
 *   cache key. If the stored SHA-256 matches the current file, skip re-embedding.
 *
 * See docs/MEMORY-V2-PLAN.md for architecture.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { logger } from '../logger.js';
import { embedTexts } from './embed.js';
import { MEMORY_SOURCES } from './sources.js';
import {
  upsertFileChunks,
  getFileChecksums,
  type ChunkRecord,
  type MemoryScope,
} from './index-store.js';
import type { RegisteredGroup } from '../types.js';

const MAX_CHUNK_CHARS = 2000;

// ─── Chunking ────────────────────────────────────────────────────────────────

interface RawChunk {
  text: string;
  lineStart: number; // 1-based
  lineEnd: number; // 1-based
}

/**
 * Hybrid heading-bounded chunker with paragraph-level sub-chunking for large
 * sections. Each chunk maps to a contiguous line range in the source file.
 */
function chunkMarkdown(content: string): RawChunk[] {
  const lines = content.split('\n');

  // Heading lines delimit sections (any level: #..######).
  const headingIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) headingIdxs.push(i);
  }

  // Build [startIdx, endIdx) boundaries (0-based).
  const bounds: Array<[number, number]> = [];
  if (headingIdxs.length === 0) {
    bounds.push([0, lines.length]);
  } else {
    if (headingIdxs[0] > 0) bounds.push([0, headingIdxs[0]]);
    for (let i = 0; i < headingIdxs.length; i++) {
      const end =
        i + 1 < headingIdxs.length ? headingIdxs[i + 1] : lines.length;
      bounds.push([headingIdxs[i], end]);
    }
  }

  const result: RawChunk[] = [];

  for (const [start, end] of bounds) {
    const sectionLines = lines.slice(start, end);
    const text = sectionLines.join('\n').trim();
    if (!text) continue;

    if (text.length <= MAX_CHUNK_CHARS) {
      result.push({ text, lineStart: start + 1, lineEnd: end });
      continue;
    }

    // Sub-chunk at paragraph breaks (consecutive blank lines → boundary).
    const paras: Array<[number, number]> = []; // [startOff, endOff) within sectionLines
    let pStart = 0;
    for (let i = 0; i <= sectionLines.length; i++) {
      if (i === sectionLines.length || !sectionLines[i].trim()) {
        if (i > pStart) paras.push([pStart, i]);
        pStart = i + 1;
      }
    }

    // Merge consecutive paragraphs up to MAX_CHUNK_CHARS.
    let bufText = '';
    let bufStartOff = 0;
    let bufEndOff = 0;

    const flush = () => {
      const t = bufText.trim();
      if (t) {
        result.push({
          text: t,
          lineStart: start + bufStartOff + 1,
          lineEnd: start + bufEndOff,
        });
      }
      bufText = '';
    };

    for (const [ps, pe] of paras) {
      const paraText = sectionLines.slice(ps, pe).join('\n');
      const candidate = bufText ? bufText + '\n\n' + paraText : paraText;
      if (bufText && candidate.length > MAX_CHUNK_CHARS) {
        flush();
        bufStartOff = ps;
      }
      if (!bufText) bufStartOff = ps;
      bufText = candidate;
      bufEndOff = pe;
    }
    flush();
  }

  return result;
}

// ─── Frontmatter domain hints ────────────────────────────────────────────────

function parseFrontmatterDomains(content: string): string[] {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return [];
  const end = content.indexOf('\n---', 4);
  if (end === -1) return [];
  const fm = content.slice(4, end);
  const m = fm.match(/^domains:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// ─── File walking ────────────────────────────────────────────────────────────

function walkMd(root: string, globPattern: string): string[] {
  if (!fs.existsSync(root)) return [];

  if (globPattern === 'CLAUDE.md') {
    const p = path.join(root, 'CLAUDE.md');
    return fs.existsSync(p) ? [p] : [];
  }

  // '**/*.md' — walk recursively
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) results.push(full);
    }
  };
  walk(root);
  return results;
}

// ─── Reindex ─────────────────────────────────────────────────────────────────

export interface IndexStats {
  filesIndexed: number;
  filesSkipped: number;
  chunksUpserted: number;
  errors: number;
}

export interface ReindexOptions {
  /**
   * partial=true (default): skip files where stored SHA-256 matches current.
   * partial=false: force re-embed all files.
   */
  partial?: boolean;
  /** If set, limit reindex to this single absolute host file path. */
  filePath?: string;
}

/**
 * Reindex memory sources for one group. Partial scan by default.
 */
export async function reindexGroup(
  groupFolder: string,
  opts: ReindexOptions = {},
): Promise<IndexStats> {
  const partial = opts.partial ?? true;
  const stats: IndexStats = {
    filesIndexed: 0,
    filesSkipped: 0,
    chunksUpserted: 0,
    errors: 0,
  };

  let storedChecksums = new Map<string, string>();
  if (partial) {
    try {
      storedChecksums = await getFileChecksums(groupFolder);
    } catch (err) {
      logger.warn(
        { groupFolder, err: (err as Error).message },
        'indexer: checksum fetch failed, falling back to full reindex',
      );
    }
  }

  for (const source of MEMORY_SOURCES) {
    const root = source.pathFor(groupFolder);
    let files: string[];

    if (opts.filePath) {
      // Single-file mode: only process this file if it belongs to this source root.
      if (
        !opts.filePath.startsWith(root + path.sep) &&
        opts.filePath !== path.join(root, 'CLAUDE.md')
      ) {
        continue;
      }
      files = fs.existsSync(opts.filePath) ? [opts.filePath] : [];
    } else {
      files = walkMd(root, source.globPattern);
    }

    for (const filePath of files) {
      try {
        let rawContent: Buffer;
        try {
          rawContent = fs.readFileSync(filePath);
        } catch {
          continue; // deleted between walk and read
        }

        const sha256 = crypto
          .createHash('sha256')
          .update(rawContent)
          .digest('hex');

        if (partial && storedChecksums.get(filePath) === sha256) {
          stats.filesSkipped++;
          continue;
        }

        const content = rawContent.toString('utf-8');
        const mtime = fs.statSync(filePath).mtimeMs;

        // Derive domain tags: folder default + frontmatter overrides.
        const relPath = path.relative(root, filePath);
        const folderDomain = source.domainFromPath
          ? source.domainFromPath(relPath)
          : null;
        const fmDomains = parseFrontmatterDomains(content);
        const domains: string[] = folderDomain
          ? [folderDomain, ...fmDomains.filter((d) => d !== folderDomain)]
          : fmDomains;

        const rawChunks = chunkMarkdown(content);
        if (rawChunks.length === 0) {
          stats.filesSkipped++;
          continue;
        }

        const embeddings = await embedTexts(
          rawChunks.map((c) => c.text),
          { inputType: 'document' },
        );

        const records: ChunkRecord[] = rawChunks.map((c, i) => ({
          chunk_id: crypto
            .createHash('sha256')
            .update(`${groupFolder}:${filePath}:${i}`)
            .digest('hex')
            .slice(0, 16),
          file_path: filePath,
          chunk_index: i,
          line_start: c.lineStart,
          line_end: c.lineEnd,
          content: c.text,
          scope: source.scope as MemoryScope,
          domains: JSON.stringify(domains),
          source_mtime: mtime,
          source_sha256: sha256,
        }));

        await upsertFileChunks(groupFolder, records, embeddings);
        stats.filesIndexed++;
        stats.chunksUpserted += records.length;
      } catch (err) {
        logger.warn(
          { groupFolder, filePath, err: (err as Error).message },
          'indexer: file indexing error',
        );
        stats.errors++;
      }
    }
  }

  logger.info({ groupFolder, ...stats }, 'indexer: reindexGroup complete');
  return stats;
}

/**
 * Startup scan — fire-and-forget partial reindex for all registered groups.
 * Errors per group are logged but don't block startup or other groups.
 */
export function startupReindex(groups: RegisteredGroup[]): void {
  const folders = [...new Set(groups.map((g) => g.folder))];
  Promise.all(
    folders.map((folder) =>
      reindexGroup(folder, { partial: true }).catch((err) =>
        logger.warn(
          { folder, err: (err as Error).message },
          'indexer: startupReindex error',
        ),
      ),
    ),
  ).then(() => {
    logger.info({ groups: folders.length }, 'indexer: startupReindex done');
  });
}
