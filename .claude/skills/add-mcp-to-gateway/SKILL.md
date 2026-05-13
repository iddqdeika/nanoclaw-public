---
name: add-mcp-to-gateway
description: Register a new MCP server with the host-side MCP gateway. Use this when adding any credentialed MCP server (Atlassian/Jira-like, Grafana-like, GitLab-like, Google Workspace, etc.) that should NOT live inside the container.
---

# Adding a new MCP to the gateway

The gateway is a host-side process that proxies MCP servers on behalf of agent containers. Each MCP becomes a "category" the agent reaches via four meta-tools (`list_categories`, `inspect_category`, `inspect_tool`, `call_tool_once`) — there is no per-session activation step. Architecture and verification commands: [`docs/MCP-GATEWAY.md`](../../../docs/MCP-GATEWAY.md).

> Use this skill when:
> - The MCP holds credentials you don't want to hand to the container.
> - You want the agent to discover the MCP on demand and call it without paying for the full tool schema in every prompt.
>
> Categories and tier permissions are configured in `groups/_gateway/acl.json` (gitignored). The shipped repo includes `groups/_gateway/acl.example.json` as a template. **No code changes or rebuild are required to add an MCP — just edit the JSON and restart nanoclaw.**

## Six steps

### 1. Install the binary on the host

The gateway runs as part of the `nanoclaw` PM2 process — on the **host** OS. The MCP binary must be reachable from there, not just from inside the container.

| Source | Command |
|---|---|
| Python uv tool | `uv tool install <package>` (installs to `~/.local/bin` on Unix, `~\.local\bin` on Windows) |
| Global npm | `npm install -g <package>` |
| Vendored | Build under a vendor dir of your choice and reference the absolute path |

On Windows, npm installs ship as `.cmd` shims that Node `spawn` can't find without `shell: true`. Reference the JS entry directly:
```json
"command": "node",
"args": ["${env:APPDATA}/npm/node_modules/<pkg>/build/index.js"]
```

`${env:VAR}` interpolation is supported in `command`, `args`, and the values of `envFromSecrets` / `envStatic`. The substitution happens at gateway load time against the host's `process.env`, so the JSON stays portable across machines.

### 2. Add a category to `groups/_gateway/acl.json`

If the file doesn't exist yet, copy the example:

```bash
cp groups/_gateway/acl.example.json groups/_gateway/acl.json
```

Then add an entry under `categories`:

```json
{
  "categories": {
    "mynewmcp": {
      "description": "One-line description shown to the agent in list_categories.",
      "command": "my-mcp-binary",
      "args": [],
      "envFromSecrets": {
        "MY_API_TOKEN": "MY_API_TOKEN",
        "MY_API_URL": "MY_API_URL"
      },
      "envStatic": { "MY_LOG_LEVEL": "info" }
    }
  }
}
```

Notes:
- The object key (`mynewmcp`) is the category name the agent sees.
- `envFromSecrets` maps the env-var-name the MCP reads → key-in-`mcp-secrets.json`.
- `envStatic` is optional and merged after secrets at spawn time.
- The agent never sees individual tools registered as MCP tools — instead it discovers them via `list_categories` → `inspect_category({category:'mynewmcp'})` → `inspect_tool({name:'mynewmcp__list_x'})` → `call_tool_once({name:'mynewmcp__list_x', arguments:{...}})`.

### 3. Put credentials in `groups/_gateway/mcp-secrets.json`

This file is the gateway's master secret store. It's gitignored, never mounted into containers.

```bash
# View current keys
cat groups/_gateway/mcp-secrets.json

# Add new keys with your editor — the file is plain JSON
```

### 4. Decide tier ACL in `groups/_gateway/acl.json`

Same file, `tierAcl` section:

```json
{
  "tierAcl": {
    "main":      ["mynewmcp", "..."],
    "trusted":   ["mynewmcp", "..."],
    "untrusted": ["..."]
  }
}
```

Tier-by-tier guidance:
- `main` — usually gets everything (admin-level group).
- `trusted` — include if trusted groups should see it.
- `untrusted` — omit unless the MCP is explicitly safe (no writes, no PII).

### 5. Restart

```bash
pm2 restart nanoclaw
```

No build or Docker rebuild needed — the gateway reads `acl.json` at startup.

### 6. Verify

```bash
# Issue a token at the tier you added the MCP to
TOKEN=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"groupFolder":"slack_main","trustLevel":"main"}' \
  http://127.0.0.1:3002/tokens | jq -r .data.token)

# /list-categories should include 'mynewmcp'
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3002/list-categories \
  | jq '.data.categories[] | select(.name=="mynewmcp")'

# /inspect-category should return a non-empty tools[] array
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"category":"mynewmcp"}' \
  http://127.0.0.1:3002/inspect-category \
  | jq '.data.tools | length'

# Tier denial — call_tool should refuse a category not in the tier ACL
TOKEN_U=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"groupFolder":"x","trustLevel":"untrusted"}' \
  http://127.0.0.1:3002/tokens | jq -r .data.token)
curl -sS -X POST -H "Authorization: Bearer $TOKEN_U" \
  -H 'content-type: application/json' \
  -d '{"name":"mynewmcp__some_tool","arguments":{}}' \
  http://127.0.0.1:3002/call-tool
# expected: {"ok":false,"error":"tier 'untrusted' not allowed for 'mynewmcp'"}
# (unless you added it to tierAcl.untrusted)
```

If `inspect-category` returns `tools: []`, the MCP failed to spawn:
- Wrong `command` (binary not on host PATH) — try running it manually.
- Required env var missing — check `envFromSecrets` keys match entries in `groups/_gateway/mcp-secrets.json`.
- MCP crashed on startup — check `pm2 logs nanoclaw` for `mcp-gateway: list-tools failed for category mynewmcp`.

### 7. (optional) Add a discovery rule for agents

Without guidance, the agent may not realize the new category exists. Add a tier-scoped rule:

```bash
cat > rules/core/when-to-use-mynewmcp.md << 'EOF'
# When to use mynewmcp

If the user asks about <X domain>, call:
  inspect_category({ category: 'mynewmcp' })           # see what tools are available
  inspect_tool({ name: 'mynewmcp__list_x' })           # see input schema
  call_tool_once({ name: 'mynewmcp__list_x', arguments: {...} })

There is no per-session activation — call_tool_once dispatches directly.
EOF
```

`rules/core/` is loaded into all trust levels' system prompts. Use `rules/trusted/` or `rules/admin/` to scope tighter.

## Checklist

- [ ] Host binary installed and resolvable from PATH (or full path used in `command`)
- [ ] Entry added under `categories` in `groups/_gateway/acl.json`
- [ ] Secret keys added to `groups/_gateway/mcp-secrets.json`
- [ ] Category added to `tierAcl` for every tier that should access it
- [ ] `pm2 restart nanoclaw`
- [ ] `/list-categories` shows the category with non-empty `tools[]`
- [ ] Untrusted ACL denial verified (if applicable)
- [ ] Optional: `rules/{tier}/when-to-use-mynewmcp.md` added so agents know about it

## Removing an MCP

1. Delete the entry from `categories` in `groups/_gateway/acl.json`.
2. Delete the entry from every `tierAcl` array.
3. Optionally: delete its keys from `groups/_gateway/mcp-secrets.json`.
4. `pm2 restart nanoclaw`.

Active sessions resume cleanly; the next `/list-categories` call from any container won't include the removed category.
