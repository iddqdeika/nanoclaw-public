---
name: add-composio-mcp
description: Wire Composio (composio.dev) into the host-side MCP gateway as a remote tool catalogue. Use when the user wants Gmail/Slack/GitHub/Notion/etc. tools served via Composio's hosted MCP endpoint instead of installing each integration locally.
---

# Adding Composio MCP to the gateway

Composio publishes a single remote MCP URL that fronts dozens of integrations (Gmail, Slack, GitHub, Notion, Linear, …). Each Composio workspace gets its own URL + API key.

NanoClaw's gateway speaks **stdio MCP**, Composio speaks **HTTP/SSE MCP** — bridge them with `mcp-remote`, registered as a gateway category. No binary install, no Dockerfile change.

Prerequisite reading: [`add-mcp-to-gateway`](../add-mcp-to-gateway/SKILL.md) for the general gateway model and ACL semantics.

## Six steps

### 1. Create the MCP server in your Composio dashboard

1. Sign in at https://dashboard.composio.dev
2. Connect the integrations you want exposed (Gmail, Slack, …)
3. Open **Connected accounts → MCP** (or **Connect → MCP clients**)
4. Note the **MCP URL** (commonly `https://connect.composio.dev/mcp`) and the **API key** (starts with `ck_`)

### 2. Verify auth before wiring it in

Composio expects the API key in `x-consumer-api-key`, **not** `Authorization: Bearer`. Wrong header gives HTTP 401 with no clear error in the agent. Confirm before editing the ACL:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST \
  -H "x-consumer-api-key: ck_YOUR_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  https://connect.composio.dev/mcp
```

`HTTP 200` → key + URL good. `HTTP 401` → wrong header or expired key. `HTTP 404` → wrong URL path.

### 3. Add a `composio` category to `groups/_gateway/acl.json`

If the file doesn't exist yet, copy from the template:

```bash
cp groups/_gateway/acl.example.json groups/_gateway/acl.json
```

Add under `categories`:

```json
"composio": {
  "description": "Composio MCP — remote tool catalogue (Gmail, Slack, GitHub, Notion, …) bridged via mcp-remote.",
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote",
    "https://connect.composio.dev/mcp",
    "--header",
    "x-consumer-api-key: ck_YOUR_KEY"
  ],
  "envFromSecrets": {},
  "envStatic": {}
}
```

The key sits inline because `mcp-remote`'s `--header` flag wants the literal header string and doesn't read env vars for it. `acl.json` is gitignored, so this is local-only — the key never leaves the host.

If you don't want the key in the ACL file at all, see *Keeping the key out of acl.json* below.

### 4. Scope it to the right tier

Add `"composio"` to one or more entries in `tierAcl`:

```json
"tierAcl": {
  "main": ["composio"],
  "trusted": ["composio"],
  "untrusted": []
}
```

| Tier | Recommendation |
|---|---|
| `main` | Fine — main groups are your own DMs / private channels. |
| `trusted` | Fine — same reasoning. |
| `untrusted` | **Do not add.** Untrusted groups can be prompt-injected by external users; exposing Composio means they could trick the agent into sending Gmails or Slack DMs from *your* connected accounts. |

### 5. Flip `useMcpGateway` on the target groups

Each group that should reach Composio (or any gateway MCP at all) needs `containerConfig.useMcpGateway = true`. Without it the agent-runner uses the legacy direct path and never sees the gateway, no matter what's in the ACL.

For an existing group, set it via SQLite — there's no CLI for this yet:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('telegram_main');
const cfg = row.container_config ? JSON.parse(row.container_config) : {};
cfg.useMcpGateway = true;
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(cfg), 'telegram_main');
console.log('done');
"
```

Replace `telegram_main` with your group's folder name.

### 6. Restart and test

Restart NanoClaw so the gateway re-reads `acl.json` and the new env propagates into newly-spawned containers:

```bash
pm2 restart nanoclaw       # see windows-ops/SKILL.md "Restart safety" first if anyone's mid-turn
```

In the chat, ask the agent:

> List the Composio categories available to you.

The agent should call `mcp__gateway__list_categories`, see `composio` in the list, then `mcp__gateway__inspect_category("composio")` to enumerate the Composio tools without paying for the full schema upfront. From there it can `call_tool_once` to actually use them.

## Keeping the key out of acl.json

If you'd rather have the key live in `groups/_gateway/mcp-secrets.json` (also gitignored) instead of inline in `args`, wrap `mcp-remote` in a tiny launcher:

`scripts/composio-mcp.sh`:
```bash
#!/usr/bin/env bash
exec npx -y mcp-remote https://connect.composio.dev/mcp \
  --header "x-consumer-api-key: $COMPOSIO_API_KEY"
```

ACL category:
```json
"composio": {
  "command": "bash",
  "args": ["scripts/composio-mcp.sh"],
  "envFromSecrets": {
    "COMPOSIO_API_KEY": "COMPOSIO_API_KEY"
  },
  "envStatic": {}
}
```

`groups/_gateway/mcp-secrets.json`:
```json
{ "COMPOSIO_API_KEY": "ck_..." }
```

The wrapper script can be committed; secrets and ACL stay local.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent says "Composio not connected" with no tool calls | `useMcpGateway` not set on the group | Step 5 above |
| Gateway log shows `Spawning MCP subprocess for gateway` repeatedly but tools never appear | `mcp-remote` handshake failing | Run the curl in step 2; 401 = header name wrong (`x-consumer-api-key`, not `Authorization`) |
| First call hangs 30+ seconds | `npx -y` cold-starting `mcp-remote` | Install once on host: `npm install -g mcp-remote`, then change the args to `["mcp-remote", "https://..."]` (drop `npx -y`) |
| Tools appear but every call returns 401 | API key valid for one workspace, but you connected to a different one | Recreate the MCP client in the right workspace; re-copy the URL+key |
| HTTP 404 on the curl test | Wrong URL path | Re-copy the URL from the dashboard; some workspaces use `https://apollo.composio.dev/v3/mcp/...` |

## Removing Composio

1. Drop the `composio` entry from `categories` and from every `tierAcl` list in `groups/_gateway/acl.json`.
2. `pm2 restart nanoclaw`.

No image rebuild or code change needed.
