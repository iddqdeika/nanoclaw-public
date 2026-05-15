import http from 'http';

import { categoriesForTier, getCategories, isAllowed, TrustLevel } from './acl.js';
import { logger } from '../logger.js';
import { SubprocessPool } from './subprocess-pool.js';
import { TokenStore } from './tokens.js';

interface SessionState {
  token: string;
  groupFolder: string;
  trustLevel: TrustLevel;
  createdAt: number;
}

interface RpcResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) {
        // Cap at 5MB; tool args of that size shouldn't happen via this path.
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

export interface GatewayServer {
  port: number;
  close(): Promise<void>;
  issueTokenInProcess(
    groupFolder: string,
    trustLevel: TrustLevel,
  ): { token: string; expiresAt: number };
}

export interface StartGatewayOpts {
  port: number;
  bindHost?: string; // default 127.0.0.1
}

export async function startMcpGateway(
  opts: StartGatewayOpts,
): Promise<GatewayServer> {
  const tokens = new TokenStore();
  const sessions = new Map<string, SessionState>();
  const pool = new SubprocessPool();

  // Periodic token cleanup
  const pruneInterval = setInterval(() => {
    const removed = tokens.prune();
    if (removed > 0) {
      logger.debug({ removed }, 'mcp-gateway: pruned expired tokens');
    }
  }, 60_000);
  pruneInterval.unref?.();

  function authenticate(req: http.IncomingMessage): SessionState | null {
    const auth = req.headers['authorization'];
    if (!auth || Array.isArray(auth)) return null;
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const tokenInfo = tokens.get(m[1]);
    if (!tokenInfo) return null;
    let session = sessions.get(tokenInfo.token);
    if (!session) {
      session = {
        token: tokenInfo.token,
        groupFolder: tokenInfo.groupFolder,
        trustLevel: tokenInfo.trustLevel,
        createdAt: Date.now(),
      };
      sessions.set(tokenInfo.token, session);
    }
    return session;
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url || '';
    const method = req.method || 'GET';

    // POST /tokens — issue a new bearer token. Called from container-runner
    // on the host (loopback only — bound to 127.0.0.1 by default).
    if (url === '/tokens' && method === 'POST') {
      const body = await readBody(req);
      let parsed: { groupFolder?: string; trustLevel?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        return writeJson(res, 400, { ok: false, error: 'invalid json' });
      }
      const tier = parsed.trustLevel as TrustLevel | undefined;
      if (!parsed.groupFolder || !tier) {
        return writeJson(res, 400, { ok: false, error: 'missing fields' });
      }
      if (!['main', 'trusted', 'untrusted'].includes(tier)) {
        return writeJson(res, 400, { ok: false, error: 'invalid trustLevel' });
      }
      const issued = tokens.issue(parsed.groupFolder, tier);
      logger.info(
        { groupFolder: parsed.groupFolder, trustLevel: tier },
        'mcp-gateway: issued token',
      );
      return writeJson(res, 200, {
        ok: true,
        data: { token: issued.token, expiresAt: issued.expiresAt },
      });
    }

    // DELETE /tokens — revoke a bearer token (called on container shutdown).
    if (url === '/tokens' && method === 'DELETE') {
      const auth = req.headers['authorization'];
      if (!auth || Array.isArray(auth)) {
        return writeJson(res, 401, { ok: false, error: 'no auth' });
      }
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m) return writeJson(res, 401, { ok: false, error: 'bad auth' });
      tokens.revoke(m[1]);
      sessions.delete(m[1]);
      return writeJson(res, 200, { ok: true });
    }

    // All RPC endpoints require Bearer auth.
    const session = authenticate(req);
    if (!session) {
      return writeJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    // Discovery layer 1: cheap — names and one-line descriptions only.
    // Pair with /inspect-category for the next level of detail.
    if (url === '/list-categories' && method === 'POST') {
      const allowed = categoriesForTier(session.trustLevel);
      const cats = getCategories();
      const categories = allowed.map((cat) => {
        const def = cats[cat];
        return {
          name: def.name,
          description: def.description,
        };
      });
      return writeJson(res, 200, { ok: true, data: { categories } });
    }

    // Discovery layer 2: tool names + one-line descriptions for one
    // category. No schemas (use /inspect-tool for those). Spawns the
    // underlying MCP subprocess if not yet up.
    if (url === '/inspect-category' && method === 'POST') {
      const body = await readBody(req);
      let parsed: { category?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        return writeJson(res, 400, { ok: false, error: 'invalid json' });
      }
      const category = parsed.category;
      if (!category) {
        return writeJson(res, 400, { ok: false, error: 'category required' });
      }
      if (!isAllowed(session.trustLevel, category)) {
        return writeJson(res, 403, {
          ok: false,
          error: `tier '${session.trustLevel}' not allowed to inspect '${category}'`,
        });
      }
      const def = getCategories()[category];
      try {
        const tools = await pool.listTools(category);
        return writeJson(res, 200, {
          ok: true,
          data: {
            name: def.name,
            description: def.description,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
          },
        });
      } catch (err) {
        return writeJson(res, 500, {
          ok: false,
          error: `failed to inspect: ${(err as Error).message}`,
        });
      }
    }

    // Return a single tool's full schema without registering anything. Pairs
    // with /call-tool so the agent can read input shape, then dispatch —
    // both in the same turn, no SDK tool-list refresh needed.
    if (url === '/inspect-tool' && method === 'POST') {
      const body = await readBody(req);
      let parsed: { name?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        return writeJson(res, 400, { ok: false, error: 'invalid json' });
      }
      if (!parsed.name) {
        return writeJson(res, 400, { ok: false, error: 'name required' });
      }
      const sep = parsed.name.indexOf('__');
      if (sep === -1) {
        return writeJson(res, 400, {
          ok: false,
          error: `tool name must be 'category__tool', got '${parsed.name}'`,
        });
      }
      const category = parsed.name.slice(0, sep);
      const toolName = parsed.name.slice(sep + 2);
      if (!isAllowed(session.trustLevel, category)) {
        return writeJson(res, 403, {
          ok: false,
          error: `tier '${session.trustLevel}' not allowed for '${category}'`,
        });
      }
      try {
        const tools = await pool.listTools(category);
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          return writeJson(res, 404, {
            ok: false,
            error: `tool '${parsed.name}' not found`,
          });
        }
        return writeJson(res, 200, {
          ok: true,
          data: {
            name: `${category}__${toolName}`,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
        });
      } catch (err) {
        return writeJson(res, 500, {
          ok: false,
          error: `failed to inspect: ${(err as Error).message}`,
        });
      }
    }

    // The single dispatch endpoint. The shim's `call_tool_once` meta-tool is
    // always present in the model's tool list, so calling it never requires a
    // tool-list refresh — sidesteps anthropics/claude-code#13646. ACL is a
    // tier × category check; per-tool ACL is out of scope (see research doc).
    if (url === '/call-tool' && method === 'POST') {
      const body = await readBody(req);
      let parsed: { name?: string; arguments?: Record<string, unknown> };
      try {
        parsed = JSON.parse(body);
      } catch {
        return writeJson(res, 400, { ok: false, error: 'invalid json' });
      }
      if (!parsed.name) {
        return writeJson(res, 400, { ok: false, error: 'name required' });
      }
      const sep = parsed.name.indexOf('__');
      if (sep === -1) {
        return writeJson(res, 400, {
          ok: false,
          error: `tool name must be 'category__tool', got '${parsed.name}'`,
        });
      }
      const category = parsed.name.slice(0, sep);
      const toolName = parsed.name.slice(sep + 2);
      if (!isAllowed(session.trustLevel, category)) {
        return writeJson(res, 403, {
          ok: false,
          error: `tier '${session.trustLevel}' not allowed for '${category}'`,
        });
      }
      try {
        const result = await pool.callTool(
          category,
          toolName,
          parsed.arguments || {},
        );
        return writeJson(res, 200, { ok: true, data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return writeJson(res, 500, { ok: false, error: msg });
      }
    }

    return writeJson(res, 404, {
      ok: false,
      error: 'not found',
    } as RpcResponse);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, 'mcp-gateway: handler error');
      try {
        writeJson(res, 500, { ok: false, error: (err as Error).message });
      } catch {
        /* response may already be partly written */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bindHost || '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info(
    { port: opts.port, bindHost: opts.bindHost || '127.0.0.1' },
    'mcp-gateway: HTTP server listening',
  );

  return {
    port: opts.port,
    issueTokenInProcess(groupFolder, trustLevel) {
      const t = tokens.issue(groupFolder, trustLevel);
      return { token: t.token, expiresAt: t.expiresAt };
    },
    async close() {
      clearInterval(pruneInterval);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.shutdownAll();
    },
  };
}
