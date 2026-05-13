import fs from 'fs';
import path from 'path';

export type TrustLevel = 'main' | 'trusted' | 'untrusted';
export type RuleTier = 'core' | 'trusted' | 'admin' | 'untrusted';

const RULES_DIR = path.join(process.cwd(), 'rules');

function readTierFiles(tier: RuleTier): string[] {
  const dir = path.join(RULES_DIR, tier);
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }

  return files.flatMap((f) => {
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8').trim();
      return content ? [content] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Which rule tiers apply to each trust level.
 * - main:      core + trusted + admin (full stack)
 * - trusted:   core + trusted (no admin-only rules like rule management)
 * - untrusted: core + untrusted (security-restricted)
 */
const TIERS_BY_TRUST: Record<TrustLevel, RuleTier[]> = {
  main: ['core', 'trusted', 'admin'],
  trusted: ['core', 'trusted'],
  untrusted: ['core', 'untrusted'],
};

/**
 * Load rules for a container invocation.
 * Returns concatenated markdown for all tiers applicable to the trust level.
 */
export function loadRules(trustLevel: TrustLevel): string {
  const parts: string[] = [];
  for (const tier of TIERS_BY_TRUST[trustLevel]) {
    parts.push(...readTierFiles(tier));
  }
  return parts.join('\n\n---\n\n');
}
