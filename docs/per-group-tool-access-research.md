# Per-Group Tool Access Control — Research

## Problem

`allowedTools` and `mcpServers` in `container/agent-runner/src/index.ts` are static. Every group — main, personal, family, work — gets the same tools. If you add Atlassian MCP, every group can query Jira. There is no gating.

---

## What Exists Today

### Available discriminators at query time

`ContainerInput` carries two fields useful for access control:

```typescript
interface ContainerInput {
  groupFolder: string;  // e.g. "slack_main", "telegram_family"
  isMain: boolean;      // true for the elevated main control group
  ...
}
```

Both are available before the `query()` call in `runQuery()`. `isMain` is already used at line 418 to conditionally load `global/CLAUDE.md`.

### Current de-facto "access control"

MCP servers read credentials from `/workspace/group/mcp-secrets.json`:

```typescript
env: (() => {
  try {
    return JSON.parse(fs.readFileSync('/workspace/group/mcp-secrets.json', 'utf-8'));
  } catch {
    return {};
  }
})(),
```

Groups without `mcp-secrets.json` get `env: {}`. The MCP server starts but all API calls fail with auth errors. This is a soft barrier — the tool is listed, the agent tries, fails, and reports an error. Not a clean restriction.

---

## Three Implementation Approaches

### Approach 1 — Conditional mcpServers (recommended)

Gate entire MCP servers based on `containerInput.isMain` or folder name. Non-qualifying groups don't start the server at all — the tools don't appear in the agent's tool list.

```typescript
const isMain = containerInput.isMain;
const groupFolder = containerInput.groupFolder;

// Groups allowed to use internal/sensitive MCPs
const hasAtlassian = isMain || groupFolder === 'slack_work';
const hasObservability = isMain;

mcpServers: {
  nanoclaw: { /* always present */ },
  ...(hasAtlassian ? {
    atlassian: {
      command: 'mcp-atlassian',
      args: [],
      env: readSecrets(),
    },
  } : {}),
  ...(hasObservability ? {
    grafana: { command: 'mcp-grafana', args: [], env: readSecrets() },
    clickhouse: { command: 'mcp-clickhouse', args: [], env: readSecrets() },
  } : {}),
},
```

Result: excluded groups never see the tools. The agent doesn't know they exist.

### Approach 2 — Conditional allowedTools

Keep all MCP servers running but remove tool patterns from `allowedTools` for restricted groups. The server starts but the SDK refuses to call the tools.

```typescript
const allowedTools = [
  'Bash', 'Read', 'Write', /* ... core tools ... */
  'mcp__nanoclaw__*',
  ...(containerInput.isMain ? ['mcp__atlassian__*', 'mcp__grafana__*', 'mcp__clickhouse__*'] : []),
];
```

This is weaker than Approach 1: the MCP server still starts (wasting resources), and the agent may still hallucinate tool availability from session memory.

### Approach 3 — Secrets absence (current state, not recommended)

Don't write `mcp-secrets.json` to restricted group folders. MCP server starts, tools appear, agent tries, API calls fail. The agent sees error messages and may retry or confuse the user. Avoid.

---

## Recommended Implementation

**Use Approach 1** (conditional mcpServers spread). It is the cleanest: restricted groups never have tools registered, agent never sees them, no wasted MCP processes.

### Pattern

Define access predicates at the top of `runQuery()` and spread conditionally into `mcpServers`:

```typescript
async function runQuery(/* ... */) {
  const isMain = containerInput.isMain;
  
  // Helper — read credentials from group secrets file
  const readSecrets = () => {
    try {
      return JSON.parse(fs.readFileSync('/workspace/group/mcp-secrets.json', 'utf-8'));
    } catch {
      return {};
    }
  };

  // Access predicates — extend as needed
  const canUseAtlassian = isMain;
  const canUseObservability = isMain;

  for await (const message of query({
    // ...
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage', 'TodoWrite',
      'ToolSearch', 'Skill', 'NotebookEdit',
      'mcp__nanoclaw__*',
      ...(canUseAtlassian ? ['mcp__atlassian__*'] : []),
      ...(canUseObservability ? ['mcp__grafana__*', 'mcp__clickhouse__*'] : []),
    ],
    mcpServers: {
      nanoclaw: { /* ... */ },
      ...(canUseAtlassian ? {
        atlassian: { command: 'mcp-atlassian', args: [], env: readSecrets() },
      } : {}),
      ...(canUseObservability ? {
        grafana: { command: 'mcp-grafana', args: [], env: readSecrets() },
        clickhouse: { command: 'mcp-clickhouse', args: [], env: readSecrets() },
      } : {}),
    },
  }))
```

### Folder-based allowlist variant

If you want non-main groups (e.g. a specific work Slack channel) to also have access:

```typescript
const ATLASSIAN_GROUPS = new Set(['slack_work', 'telegram_work']);
const canUseAtlassian = containerInput.isMain || ATLASSIAN_GROUPS.has(containerInput.groupFolder);
```

---

## Access Control Matrix Example

| Group | Core tools | Atlassian | Grafana / ClickHouse |
|-------|-----------|-----------|----------------------|
| `telegram_main` (isMain) | ✓ | ✓ | ✓ |
| `slack_work` | ✓ | ✓ | ✗ |
| `telegram_family` | ✓ | ✗ | ✗ |
| `discord_gaming` | ✓ | ✗ | ✗ |

---

## What Changes

Only one file: `container/agent-runner/src/index.ts`

- Move `readSecrets` IIFE into a named helper (avoid copy-paste × 3)
- Add access predicates before the `query()` call
- Make `allowedTools` and `mcpServers` conditional on those predicates

After editing, force the agent-runner cache to rebuild:

```bash
touch container/agent-runner/src/index.ts
rm -rf data/sessions/*/agent-runner-src
```

No Docker rebuild needed — the Dockerfile is unchanged. The per-group agent-runner cache (`data/sessions/{group}/agent-runner-src/`) is mounted into the container at `/app/src`, and the entrypoint compiles it fresh on each container start with `npx tsc`. Editing `container/agent-runner/src/index.ts` and invalidating the cache is all that's required.

---

## Caveats

**Stale sessions**: Agents running in resumed sessions saw the old tool list at session start. If you restrict a tool that was previously allowed, clear sessions for affected groups:

```bash
rm -f data/sessions/{group}/.claude/sessions/*.json
```

**isMain is a single boolean**: Only one group can be `isMain`. For multiple privileged groups, use folder-name predicates or a `Set`.

**No runtime re-evaluation**: The access check runs once at container start. Tools cannot be added or removed mid-session.
