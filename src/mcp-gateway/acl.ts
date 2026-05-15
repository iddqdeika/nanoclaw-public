/**
 * MCP Gateway ACL — types, helpers, and config loader.
 *
 * Category definitions and tier permissions live in
 * `groups/_gateway/acl.json` (gitignored). The shipped repo includes
 * `groups/_gateway/acl.example.json` as a starting template. Use the
 * /add-mcp-to-gateway skill to register an MCP.
 *
 * String fields in the JSON (`command`, each entry in `args`, and the
 * values of `envFromSecrets` / `envStatic`) support `${env:VAR}`
 * interpolation against the host's process.env at load time. Use this
 * for install-location-dependent paths (Windows %APPDATA% etc.) so the
 * config stays portable.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

export type TrustLevel = 'main' | 'trusted' | 'untrusted';

export interface CategoryDef {
  name: string;
  description: string;
  // Spawn config for the underlying MCP server stdio subprocess.
  command: string;
  args: string[];
  // Env vars to pass — values are KEYS into the master mcp-secrets.json.
  // Gateway looks them up at spawn time so secrets never appear in code.
  envFromSecrets: Record<string, string>;
  // Static env (non-secret). Merged with envFromSecrets at spawn time.
  envStatic?: Record<string, string>;
}

const CategoryDefSchema = z.object({
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  envFromSecrets: z.record(z.string(), z.string()).default({}),
  envStatic: z.record(z.string(), z.string()).optional(),
});

const AclConfigSchema = z.object({
  categories: z.record(z.string(), CategoryDefSchema).default({}),
  tierAcl: z
    .object({
      main: z.array(z.string()).default([]),
      trusted: z.array(z.string()).default([]),
      untrusted: z.array(z.string()).default([]),
    })
    .default({ main: [], trusted: [], untrusted: [] }),
});

export const ACL_CONFIG_PATH = path.join(GROUPS_DIR, '_gateway', 'acl.json');

interface AclConfig {
  categories: Record<string, CategoryDef>;
  tierAcl: Record<TrustLevel, string[]>;
}

let cached: AclConfig | undefined;

function interpolate(value: string): string {
  return value.replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, name) => {
    const v = process.env[name];
    if (v == null) {
      logger.warn(
        { var: name },
        'Gateway ACL referenced an env var that is not set; substituting empty string',
      );
      return '';
    }
    return v;
  });
}

function interpolateAll(def: z.infer<typeof CategoryDefSchema>): {
  command: string;
  args: string[];
  envFromSecrets: Record<string, string>;
  envStatic?: Record<string, string>;
} {
  const mapVals = (
    obj: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!obj) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = interpolate(v);
    return out;
  };
  return {
    command: interpolate(def.command),
    args: def.args.map(interpolate),
    envFromSecrets: mapVals(def.envFromSecrets) || {},
    envStatic: mapVals(def.envStatic),
  };
}

function loadAclConfig(): AclConfig {
  let raw: unknown = {};
  try {
    const content = fs.readFileSync(ACL_CONFIG_PATH, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.info(
        { path: ACL_CONFIG_PATH },
        'No gateway ACL config — registry empty. Use /add-mcp-to-gateway to register an MCP.',
      );
      return {
        categories: {},
        tierAcl: { main: [], trusted: [], untrusted: [] },
      };
    }
    throw err;
  }

  let parsed: z.infer<typeof AclConfigSchema>;
  try {
    parsed = AclConfigSchema.parse(raw);
  } catch (err) {
    logger.error(
      { path: ACL_CONFIG_PATH, err },
      'Gateway ACL config failed schema validation',
    );
    throw err;
  }

  const categories: Record<string, CategoryDef> = {};
  for (const [name, def] of Object.entries(parsed.categories)) {
    categories[name] = { name, description: def.description, ...interpolateAll(def) };
  }
  return { categories, tierAcl: parsed.tierAcl };
}

function get(): AclConfig {
  if (!cached) cached = loadAclConfig();
  return cached;
}

export function reloadAclConfig(): void {
  cached = undefined;
}

export function getCategories(): Record<string, CategoryDef> {
  return get().categories;
}

export function categoriesForTier(tier: TrustLevel): string[] {
  return get().tierAcl[tier] || [];
}

export function isAllowed(tier: TrustLevel, category: string): boolean {
  return categoriesForTier(tier).includes(category);
}
