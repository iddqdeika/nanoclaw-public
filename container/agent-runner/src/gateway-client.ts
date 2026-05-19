/**
 * MCP Gateway Client (stdio shim)
 *
 * Runs inside the agent container. Speaks stdio MCP to the agent-runner SDK
 * (looks like any other local MCP server) and forwards every request to the
 * host-side mcp-gateway over HTTP using a per-container bearer token.
 *
 * Three meta-tools are always exposed:
 *   - discover_tools       — list categories the tier can activate
 *   - activate_category    — activate a category; tools become callable
 *   - deactivate_category  — deactivate a category; tools disappear
 *
 * After `activate_category`, the activated tools appear as
 * `<category>__<tool>` in the tools/list response and are routable to the
 * gateway. Tool list changes are signaled to the agent SDK via
 * `notifications/tools/list_changed` so the active list is refreshed mid-
 * session.
 */

import http from 'http';
import { URL } from 'url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const GATEWAY_URL = process.env.MCP_GATEWAY_URL;
const GATEWAY_TOKEN = process.env.MCP_GATEWAY_TOKEN;
const GATEWAY_GROUP = process.env.MCP_GATEWAY_GROUP || '';

if (!GATEWAY_URL || !GATEWAY_TOKEN) {
  console.error(
    '[gateway-client] MCP_GATEWAY_URL and MCP_GATEWAY_TOKEN must be set',
  );
  process.exit(1);
}

interface GatewayResponse<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

function rpc<T = unknown>(
  pathPart: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<GatewayResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathPart, GATEWAY_URL);
    const data = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
    };
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const parsed: GatewayResponse<T> = chunks
              ? JSON.parse(chunks)
              : { ok: false, error: 'empty response' };
            resolve(parsed);
          } catch (err) {
            reject(
              new Error(
                `gateway non-JSON response (status ${res.statusCode}): ${chunks.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  category?: string;
}

interface CategorySummary {
  name: string;
  description: string;
}

// Built at startup from the gateway's /list-categories response so the
// catalog stays in sync with the host-side acl.ts (single source of truth).
// Falls back to a hardcoded list if the gateway is unreachable at boot.
let META_TOOLS: ToolEntry[] = [];

function buildMetaTools(categories: CategorySummary[]): ToolEntry[] {
  const enumValues = categories.map((c) => c.name);
  const categoryParam = (extra: string) => ({
    type: 'string' as const,
    description: extra,
    ...(enumValues.length ? { enum: enumValues } : {}),
  });

  return [
    {
      name: 'list_categories',
      description:
        'Cheap — list available tool categories with one-line descriptions. Use first to learn what categories exist.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'inspect_category',
      description:
        'List all tools in one category (names + one-line descriptions, no schemas). Use when you know the category but want to scan its tools.',
      inputSchema: {
        type: 'object',
        properties: { category: categoryParam('Category to inspect.') },
        required: ['category'],
        additionalProperties: false,
      },
    },
    {
      name: 'inspect_tool',
      description:
        'Return one tool\'s full input schema as text data, without registering it. Use this to learn argument shape before call_tool_once. Argument is the fully-qualified name "<category>__<tool>".',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Fully-qualified tool name as "<category>__<tool>".',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'call_tool_once',
      description:
        'Dispatch a single tool call. Fully-qualified name is "<category>__<tool>" (e.g. "filesystem__read_file"). Pair with inspect_tool when you need to see the input schema first. This is the only path to credentialed MCP tools — there is no per-session activation.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Fully-qualified tool name as "<category>__<tool>".',
          },
          arguments: {
            type: 'object',
            description: 'Arguments for the tool. Shape comes from inspect_tool.',
            additionalProperties: true,
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
}

// Empty fallback if the gateway is unreachable at boot. The agent's
// list_categories call still works (returns an empty list); once the
// gateway is reachable, refreshMetaToolsFromGateway populates the catalog
// from the host-side groups/_gateway/acl.json.
const FALLBACK_CATEGORIES: CategorySummary[] = [];

META_TOOLS = buildMetaTools(FALLBACK_CATEGORIES);

const server = new Server(
  { name: 'gateway', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Static surface: 4 meta-tools, no per-session activation. All credentialed
  // calls go through call_tool_once + inspect_tool.
  return {
    tools: META_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments || {}) as Record<string, unknown>;

  if (name === 'list_categories') {
    const resp = await rpc<{
      categories: Array<{ name: string; description: string }>;
    }>('/list-categories', 'POST');
    if (!resp.ok) {
      return {
        content: [{ type: 'text', text: `Error: ${resp.error}` }],
        isError: true,
      };
    }
    const cats = resp.data?.categories || [];
    if (cats.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No categories available for this tier.' },
        ],
      };
    }
    const lines = cats.map((c) => `- ${c.name}: ${c.description}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'inspect_category') {
    const category = String(args.category || '');
    const resp = await rpc<{
      name: string;
      description: string;
      tools: Array<{ name: string; description?: string }>;
    }>('/inspect-category', 'POST', { category });
    if (!resp.ok) {
      return {
        content: [{ type: 'text', text: `Error: ${resp.error}` }],
        isError: true,
      };
    }
    const data = resp.data;
    if (!data) {
      return {
        content: [{ type: 'text', text: 'No data returned.' }],
        isError: true,
      };
    }
    const lines: string[] = [];
    lines.push(`## ${data.name} — ${data.description}`);
    for (const t of data.tools) {
      lines.push(`  - ${t.name}: ${t.description || ''}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'call_tool_once') {
    const targetName = String(args.name || '');
    if (!targetName) {
      return {
        content: [{ type: 'text', text: 'name is required' }],
        isError: true,
      };
    }
    const targetArgs = (args.arguments as Record<string, unknown>) || {};
    const resp = await rpc<{
      content?: unknown[];
      isError?: boolean;
    }>('/call-tool', 'POST', { name: targetName, arguments: targetArgs });
    if (!resp.ok) {
      return {
        content: [{ type: 'text', text: `call_tool_once failed: ${resp.error}` }],
        isError: true,
      };
    }
    const data = (resp.data || {}) as {
      content?: unknown[];
      isError?: boolean;
    };
    return {
      content: (data.content as Array<{ type: string; text?: string }>) || [
        { type: 'text', text: '(no content)' },
      ],
      isError: data.isError,
    };
  }

  if (name === 'inspect_tool') {
    const targetName = String(args.name || '');
    if (!targetName) {
      return {
        content: [{ type: 'text', text: 'name is required' }],
        isError: true,
      };
    }
    const resp = await rpc<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>('/inspect-tool', 'POST', { name: targetName });
    if (!resp.ok) {
      return {
        content: [{ type: 'text', text: `inspect_tool failed: ${resp.error}` }],
        isError: true,
      };
    }
    const data = resp.data;
    const schemaText = data?.inputSchema
      ? JSON.stringify(data.inputSchema, null, 2)
      : '(no schema)';
    return {
      content: [
        {
          type: 'text',
          text:
            `## ${data?.name}\n\n${data?.description || '(no description)'}\n\n` +
            `### inputSchema\n\`\`\`json\n${schemaText}\n\`\`\``,
        },
      ],
    };
  }

  // No fallthrough: the only callable tool names are the four meta-tools
  // declared by buildMetaTools(). Anything else is an SDK bug.
  return {
    content: [{ type: 'text', text: `Unknown meta-tool: ${name}` }],
    isError: true,
  };
});

// Best-effort token revocation on shutdown.
async function revokeAndExit(): Promise<void> {
  try {
    await rpc('/tokens', 'DELETE');
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', revokeAndExit);
process.on('SIGINT', revokeAndExit);

// Fetch live category catalog from gateway before serving the first
// tools/list. Falls back to the hardcoded list if the gateway is unreachable
// (the agent will still work, just with a possibly stale catalog).
async function refreshMetaToolsFromGateway(): Promise<void> {
  try {
    const resp = await rpc<{ categories: CategorySummary[] }>(
      '/list-categories',
      'POST',
    );
    if (resp.ok && resp.data?.categories) {
      META_TOOLS = buildMetaTools(resp.data.categories);
      console.error(
        `[gateway-client] catalog: ${resp.data.categories.map((c) => c.name).join(', ')}`,
      );
    }
  } catch (err) {
    console.error(
      '[gateway-client] catalog refresh failed, using fallback:',
      (err as Error).message,
    );
  }
}

const transport = new StdioServerTransport();
refreshMetaToolsFromGateway().then(() =>
  server.connect(transport).then(
    () => {
      console.error(
        `[gateway-client] connected to ${GATEWAY_URL} as group=${GATEWAY_GROUP}`,
      );
    },
    (err) => {
      console.error('[gateway-client] failed to connect transport:', err);
      process.exit(1);
    },
  ),
);

void GATEWAY_GROUP;
