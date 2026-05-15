import crypto from 'crypto';

import type { TrustLevel } from './acl.js';

export interface TokenInfo {
  token: string;
  groupFolder: string;
  trustLevel: TrustLevel;
  createdAt: number;
  expiresAt: number;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class TokenStore {
  private tokens = new Map<string, TokenInfo>();

  issue(groupFolder: string, trustLevel: TrustLevel): TokenInfo {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const info: TokenInfo = {
      token,
      groupFolder,
      trustLevel,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    };
    this.tokens.set(token, info);
    return info;
  }

  get(token: string): TokenInfo | undefined {
    const info = this.tokens.get(token);
    if (!info) return undefined;
    if (info.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    return info;
  }

  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  // Periodically prune expired tokens.
  prune(): number {
    const now = Date.now();
    let count = 0;
    for (const [token, info] of this.tokens.entries()) {
      if (info.expiresAt < now) {
        this.tokens.delete(token);
        count++;
      }
    }
    return count;
  }

  size(): number {
    return this.tokens.size;
  }
}
