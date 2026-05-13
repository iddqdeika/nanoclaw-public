---
name: add-mcp
description: Add an MCP server to NanoClaw agent containers. Use when the user wants to give the agent access to external tools via MCP (Jira, Confluence, Notion, databases, etc.).
---

# Adding an MCP Server to NanoClaw

MCP servers run inside agent containers and give Claude access to external tools. This skill walks through the **direct in-container** path — each MCP is spawned as a child of `claude` inside the agent container with secrets read from the group's `mcp-secrets.json`.

> **There is also a host-side gateway path.** For credentialed MCPs (Jira, Grafana, ClickHouse, GitLab, feeds, …), prefer adding the MCP to the gateway instead — secrets stay on the host, agents discover/activate categories on demand, and adding a new MCP doesn't require a Docker rebuild.
>
> See [`add-mcp-to-gateway`](../add-mcp-to-gateway/SKILL.md) and [`docs/MCP-GATEWAY.md`](../../docs/MCP-GATEWAY.md). Use *this* skill (direct path) when:
> - The MCP is `nanoclaw`-style and needs container state (`/workspace/group`, IPC files).
> - You're targeting a group with `containerConfig.useMcpGateway` unset/false.

## Architecture

Every message triggers a Docker container running `nanoclaw-agent:latest`. The agent-runner inside the container initializes MCP servers at query start via the Claude Agent SDK. Key constraint: **the container has no access to the host `.env` file** — it is shadowed with `/dev/null` for security.

## The Three Parts of Adding an MCP Server

### 1. Register the MCP server in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` block inside the `query()` call:

```typescript
mcpServers: {
  nanoclaw: { ... },  // built-in IPC server — don't touch
  yourserver: {
    command: 'your-mcp-binary',
    args: [],
    env: {
      API_KEY: 'hardcoded-or-read-from-file',
    },
  },
},
```

Also add `'mcp__yourserver__*'` to `allowedTools`.

### 2. Allow the MCP tools

In the same file, find `allowedTools` and add:

```typescript
'mcp__yourserver__*',
```

### 3. Get credentials into the container

The container cannot read the host `.env`. Three options, in order of preference:

#### Option A: Pre-install binary + secrets file (recommended)

Put credentials in the group folder — it's mounted as `/workspace/group/` in the container.

**Which groups need the secrets file:** `main` and `trusted` groups. Untrusted groups never get external MCP servers started.

**Write the file once in your main group's folder:**

```bash
cat > groups/slack_main/mcp-secrets.json << 'EOF'
{
  "API_KEY": "...",
  "API_URL": "..."
}
EOF
```

**For trusted groups: the host auto-seeds the file on `register_group`.** When the main agent calls `mcp__nanoclaw__register_group(..., trusted: true)`, the host copies `mcp-secrets.json` from an existing main group's folder into the new/promoted group — if the target doesn't already have its own file. No manual copy needed.

If you want a specific trusted group to use different credentials, write its `mcp-secrets.json` manually before `register_group` (or edit it after); the seed never overwrites existing files.

Read in agent-runner:

```typescript
env: (() => {
  try {
    return JSON.parse(fs.readFileSync('/workspace/group/mcp-secrets.json', 'utf-8'));
  } catch {
    return {};
  }
})(),
```

**Pre-existing trusted groups (registered before the auto-seed was added):** one-time backfill —

```bash
SRC=groups/slack_main/mcp-secrets.json
for g in groups/*/; do
  name=$(basename "$g")
  trust=$(sqlite3 store/messages.db "SELECT CASE WHEN is_main=1 THEN 'main' WHEN container_config LIKE '%\"trusted\":true%' THEN 'trusted' ELSE 'untrusted' END FROM registered_groups WHERE folder='$name' LIMIT 1;" 2>/dev/null)
  if { [ "$trust" = "main" ] || [ "$trust" = "trusted" ]; } && [ ! -f "$g/mcp-secrets.json" ]; then
    cp "$SRC" "$g/mcp-secrets.json" && echo "seeded → $name"
  fi
done
```

#### Option B: Hardcode (personal installs only)

Fine for self-hosted personal assistants. Just put the values directly in the `env` block.

#### Option C: Inject via container args

**Do not use.** Passing `-e KEY=VALUE` to docker on Windows with Git Bash causes MSYS path mangling. The env vars never reach the container. This was extensively debugged and ruled out.

---

## Pre-installing the MCP Binary (Required for uvx-based servers)

`uvx some-mcp-server` downloads on first run. In a container, this happens during MCP init, often timing out before the server is ready. The fix: pre-install in the Docker image.

Edit `container/Dockerfile` — add to the `apt-get` RUN block:

```dockerfile
# One RUN per MCP — each becomes its own cache layer.
# Adding a new server only downloads that one; existing layers stay cached.
RUN UV_TOOL_BIN_DIR=/usr/local/bin uv tool install your-mcp-package
```

And add the ENV for the tool dir (before the apt block):

```dockerfile
ENV UV_TOOL_DIR=/opt/uv-tools
ENV PATH="/opt/uv-tools/bin:$PATH"
```

Then in the agent-runner, use the binary directly instead of `uvx`:

```typescript
// Before (slow - downloads on every cold start):
command: 'uvx',
args: ['mcp-atlassian'],

// After (instant - pre-installed in image):
command: 'mcp-atlassian',
args: [],
```

Rebuild the image:

```bash
./container/build.sh
```

---

## Stale Session Problem

When you add a new MCP server, existing resumed sessions **don't see the new tools**. Claude answers from memory of the old session where the tools didn't exist.

**Fix:** Clear the session files for the affected group before testing:

```bash
rm -f data/sessions/telegram_main/.claude/sessions/*.json
```

Also stop any running agent container so a fresh one starts:

```bash
docker ps --filter name=nanoclaw- --format '{{.Names}}' | xargs -r docker stop
```

---

## Agent-runner Cache

The agent-runner source is copied to `data/sessions/{group}/agent-runner-src/` and only refreshed when the source `index.ts` is newer than the cached copy. After editing, force a refresh:

```bash
touch container/agent-runner/src/index.ts
rm -rf data/sessions/telegram_main/agent-runner-src
rm -rf data/sessions/slack_main/agent-runner-src
```

---

## Full Checklist

- [ ] MCP server added to `mcpServers` in `container/agent-runner/src/index.ts` — registered for which trust levels?
- [ ] Tool pattern added to `allowedTools` in `TOOLS_BY_TRUST` for every trust level that should get it (e.g. `mcp__servername__*` in `main` and `trusted` if external MCP)
- [ ] Credentials written to your **main** group's `mcp-secrets.json` — new trusted groups auto-seed from here on `register_group`
- [ ] For pre-existing trusted groups registered before auto-seed: run the one-time backfill loop above
- [ ] Binary pre-installed in `container/Dockerfile` (if uvx-based)
- [ ] Docker image rebuilt: `./container/build.sh`
- [ ] Agent-runner cache cleared: `touch container/agent-runner/src/index.ts && rm -rf data/sessions/*/agent-runner-src`
- [ ] Stale sessions cleared: `rm -f data/sessions/{group}/.claude/sessions/*.json`
- [ ] Running containers stopped: `docker ps --filter name=nanoclaw- --format '{{.Names}}' | xargs -r docker stop`
- [ ] PM2 restarted: `pm2 restart nanoclaw`

---

## Example: Atlassian (Jira + Confluence)

**Package:** `mcp-atlassian`

**Dockerfile addition:**
```dockerfile
RUN UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mcp-atlassian
```

**agent-runner mcpServers:**
```typescript
atlassian: {
  command: 'mcp-atlassian',
  args: [],
  env: (() => {
    try {
      return JSON.parse(fs.readFileSync('/workspace/group/mcp-secrets.json', 'utf-8'));
    } catch {
      return {};
    }
  })(),
},
```

**allowedTools:**
```typescript
'mcp__atlassian__*',
```

**groups/telegram_main/mcp-secrets.json:**
```json
{
  "JIRA_URL": "https://yourcompany.atlassian.net",
  "JIRA_USERNAME": "you@example.com",
  "JIRA_API_TOKEN": "ATATT...",
  "CONFLUENCE_URL": "https://yourcompany.atlassian.net/wiki",
  "CONFLUENCE_USERNAME": "you@example.com",
  "CONFLUENCE_API_TOKEN": "ATATT..."
}
```

---

## Example: GitLab (`@zereight/mcp-gitlab`)

**Package:** `@zereight/mcp-gitlab` (stdio binary: `mcp-gitlab`)

**Dockerfile addition** (with other global npm installs):

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @zereight/mcp-gitlab
```

**agent-runner `mcpServers`** (same `readMcpSecrets()` as Atlassian — merge GitLab keys into `groups/{folder}/mcp-secrets.json`):

```typescript
servers.gitlab = { command: 'mcp-gitlab', args: [], env: secrets };
```

**`allowedTools`:** `'mcp__gitlab__*'`

**`mcp-secrets.json` keys** (see [environment variables](https://www.npmjs.com/package/@zereight/mcp-gitlab)):

```json
{
  "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-...",
  "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
  "GITLAB_READ_ONLY_MODE": "false",
  "USE_GITLAB_WIKI": "false",
  "USE_MILESTONE": "false",
  "USE_PIPELINE": "false"
}
```

Self-hosted instances must set `GITLAB_API_URL` to that instance’s API base (usually `https://<host>/api/v4`).

---

## Debugging

**MCP server not appearing as tools:**
```bash
# Check binary exists in image
docker run --rm --entrypoint which nanoclaw-agent:latest mcp-atlassian

# Check secrets file is readable in container
MSYS_NO_PATHCONV=1 docker exec <container> cat /workspace/group/mcp-secrets.json

# Check compiled agent-runner has the server
MSYS_NO_PATHCONV=1 docker exec <container> grep -A5 "yourserver" /tmp/dist/index.js

# Test MCP server starts with creds
MSYS_NO_PATHCONV=1 docker exec <container> bash -c 'export $(cat /workspace/group/mcp-secrets.json | python3 -c "import sys,json; [print(k+\"=\"+v) for k,v in json.load(sys.stdin).items()]") && timeout 5 mcp-atlassian 2>&1'
```

**Windows/Git Bash path mangling:**
Always prefix `docker exec` commands with `MSYS_NO_PATHCONV=1` when paths like `/app/src` are involved, or Git Bash will rewrite them to `C:/Program Files/Git/app/src`.
