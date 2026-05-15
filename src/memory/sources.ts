/**
 * Memory sources — declarative "what counts as memory" config.
 *
 * Mirrors the role of `src/mcp-gateway/acl.ts` for the gateway: this is the
 * single file you edit to add a new memory source. The indexer iterates
 * over these definitions, walks each path glob per registered group, and
 * embeds the chunks.
 *
 * Each source produces zero or more files; each file produces one or more
 * chunks; each chunk lands in the index store with the source's scope and
 * (in v1.1+) any domain tags derived from path or frontmatter.
 *
 * See:
 *   docs/MEMORY-V2-PLAN.md          (v1.0)  — overall architecture
 *   docs/MEMORY-V2-DOMAINS-PLAN.md  (v1.1)  — domain enforcement
 */
import path from 'path';
import { GROUPS_DIR } from '../config.js';

export type MemoryScope = 'group' | 'global';

/**
 * One memory source definition.
 *
 *   - `id`            stable identifier, used for logging / diagnostics
 *   - `description`   human-readable purpose (one line)
 *   - `scope`         where its chunks land: per-group or global pool
 *   - `pathFor(g)`    returns the absolute on-host path glob root for the
 *                     given group folder (or the global root, if scope=global)
 *   - `globPattern`   relative glob under the path root (e.g. '** /*.md')
 *   - `domainFromPath(relPath)`  optional — for global sources, derive the
 *                     domain id from the file's relative path. Returns null
 *                     for "loose top-level files visible to everyone."
 *                     Per-group sources never have domains.
 */
export interface MemorySource {
  id: string;
  description: string;
  scope: MemoryScope;
  pathFor: (groupFolder: string) => string;
  globPattern: string;
  domainFromPath?: (relPath: string) => string | null;
}

// Path inside groups/global where domain-tagged knowledge lives. Top-level
// folders here are domains (e.g. groups/global/memory/research/...). Loose
// files at groups/global/memory/*.md are domain-less = visible to everyone.
const GLOBAL_MEMORY_ROOT = path.join(GROUPS_DIR, 'global', 'memory');

function globalDomainFromPath(relPath: string): string | null {
  // Files at the root level (e.g. 'INDEX.md', '2026-04-28-summary.md') are
  // domain-less. Files inside a subfolder (e.g. 'research/llm-wiki.md') get
  // the subfolder name as their default domain. Frontmatter `domains: [...]`
  // can ADD additional domains at indexer time — handled there, not here.
  const norm = relPath.replace(/\\/g, '/');
  const sep = norm.indexOf('/');
  if (sep === -1) return null; // loose top-level file
  return norm.slice(0, sep);
}

export const MEMORY_SOURCES: MemorySource[] = [
  {
    id: 'group-claude-md',
    description:
      "Group's CLAUDE.md — the agent's identity, persistent prefs, current goals.",
    scope: 'group',
    pathFor: (g) => path.join(GROUPS_DIR, g),
    globPattern: 'CLAUDE.md',
  },
  {
    id: 'group-wiki',
    description:
      "Group's wiki/ directory — agent-curated structured knowledge (Karpathy LLM Wiki pattern).",
    scope: 'group',
    pathFor: (g) => path.join(GROUPS_DIR, g, 'wiki'),
    globPattern: '**/*.md',
  },
  {
    id: 'global-memory',
    description:
      'Global memory — domain-organized markdown under groups/global/memory/. Top-level files are visible to everyone; subfolder files are domain-tagged.',
    scope: 'global',
    pathFor: () => GLOBAL_MEMORY_ROOT,
    globPattern: '**/*.md',
    domainFromPath: globalDomainFromPath,
  },
];

/**
 * Helper: enumerate the on-disk roots of all distinct sources for a given
 * group, returning [{source, root}] pairs. Used by the indexer to walk.
 */
export function sourceRootsForGroup(
  groupFolder: string,
): Array<{ source: MemorySource; root: string }> {
  return MEMORY_SOURCES.map((s) => ({
    source: s,
    root: s.pathFor(groupFolder),
  }));
}
