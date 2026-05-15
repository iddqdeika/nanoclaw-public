import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';

export const GATEWAY_SECRETS_PATH = path.join(
  GROUPS_DIR,
  '_gateway',
  'mcp-secrets.json',
);

export function loadGatewaySecrets(): Record<string, string> {
  try {
    const raw = fs.readFileSync(GATEWAY_SECRETS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}
