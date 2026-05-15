import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CategoryDef, getCategories } from './acl.js';
import { logger } from '../logger.js';
import { loadGatewaySecrets } from './secrets.js';

export interface ToolDescriptor {
  name: string; // original tool name as exposed by the MCP server
  description?: string;
  inputSchema?: unknown;
}

interface PooledServer {
  category: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDescriptor[];
  spawnedAt: number;
}

/**
 * One stdio MCP subprocess per category, lazily spawned on first use,
 * shared across all gateway sessions. Tool list cached at spawn time
 * (MCP servers in scope don't dynamically change their tool list).
 */
export class SubprocessPool {
  private servers = new Map<string, PooledServer>();
  private spawning = new Map<string, Promise<PooledServer>>();

  async getOrSpawn(category: string): Promise<PooledServer> {
    const existing = this.servers.get(category);
    if (existing) return existing;

    const inflight = this.spawning.get(category);
    if (inflight) return inflight;

    const def = getCategories()[category];
    if (!def) {
      throw new Error(`Unknown category: ${category}`);
    }

    const spawnPromise = this.spawn(def)
      .then((srv) => {
        this.servers.set(category, srv);
        this.spawning.delete(category);
        return srv;
      })
      .catch((err) => {
        this.spawning.delete(category);
        throw err;
      });
    this.spawning.set(category, spawnPromise);
    return spawnPromise;
  }

  private async spawn(def: CategoryDef): Promise<PooledServer> {
    const secrets = loadGatewaySecrets();
    const env: Record<string, string> = { ...(def.envStatic || {}) };
    for (const [envKey, secretKey] of Object.entries(def.envFromSecrets)) {
      const v = secrets[secretKey];
      if (v != null) env[envKey] = v;
    }
    // Inherit PATH so commands like `mcp-grafana` resolve.
    if (process.env.PATH) env.PATH = process.env.PATH;

    logger.info(
      { category: def.name, command: def.command, args: def.args },
      'Spawning MCP subprocess for gateway',
    );

    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env,
    });
    const client = new Client(
      { name: `gateway-${def.name}`, version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const listed = await client.listTools();
    const tools: ToolDescriptor[] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    logger.info(
      { category: def.name, toolCount: tools.length },
      'MCP subprocess ready',
    );

    return {
      category: def.name,
      client,
      transport,
      tools,
      spawnedAt: Date.now(),
    };
  }

  async listTools(category: string): Promise<ToolDescriptor[]> {
    const srv = await this.getOrSpawn(category);
    return srv.tools;
  }

  async callTool(
    category: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const srv = await this.getOrSpawn(category);
    return srv.client.callTool({ name: toolName, arguments: args });
  }

  async shutdownAll(): Promise<void> {
    const closes = Array.from(this.servers.values()).map(async (srv) => {
      try {
        await srv.client.close();
      } catch (err) {
        logger.warn(
          { category: srv.category, err },
          'Error closing MCP subprocess',
        );
      }
    });
    await Promise.all(closes);
    this.servers.clear();
  }
}
