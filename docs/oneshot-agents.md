# One-Shot Agents

> Standalone, on-demand agent containers for heavy or background tasks. Spawned by the main agent or CLI, with progress updates routed to the originating chat/thread.

---

## Motivation

Current agent execution is always tied to an incoming message or a scheduled task. There's no way for the main agent to delegate heavy work (research, analysis, code generation) to a separate container that runs in parallel without blocking the conversation.

One-shot agents fill this gap: fire-and-forget containers that execute a prompt, report progress, and clean up.

---

## Design

### What is a one-shot agent?

A container that:
- Receives a prompt and executes it
- Runs in a **fresh session** (no conversation history)
- Has its own **temporary workspace** (cleaned up after N days)
- Can send **progress updates** to the originating chat/thread
- Gets **scoped rules and skills** (core + admin)
- Has access to **global memory** and **messages.db** (admin scope)
- Terminates when done — no idle wait

### How is it different from existing mechanisms?

| | Chat agent | Scheduled task (isolated) | One-shot agent |
|---|---|---|---|
| Trigger | User message | Cron/timer | On-demand (IPC or CLI) |
| Session | Persistent per group | Fresh | Fresh |
| Workspace | Permanent group folder | Permanent group folder | Temporary, auto-cleaned |
| Output | Reply to chat | Reply to chat or silent | Progress to originating chat + optional file |
| Concurrency | One per group (queued) | Parallel | Parallel |
| Timeout | Standard (30 min) | Standard | Configurable (default 60 min) |

---

## Trigger Mechanisms

### 1. MCP tool (from main agent inside container)

```
mcp__nanoclaw__spawn_agent(
  prompt: "Research all group activity from last week, write summary to /workspace/parent/weekly-report.md",
  scope: "admin",
  timeout: 600000
)
```

The agent writes an IPC file. The host picks it up, spawns a container, and returns the one-shot ID immediately. The main agent continues working.

The one-shot agent can:
- Read/write the parent group's folder via `/workspace/parent/`
- Send progress updates to the originating chat/thread via `send_message`

The agent picks the scope based on what the task needs. Use `admin` for tasks that need the database or global memory writes, `core` for simple tasks.

### 2. CLI

```bash
claw oneshot "Analyze codebase structure and write report" --scope admin --timeout 600000
```

Output streams to stdout. Progress updates also printed.

### 3. IPC file (advanced)

Write a JSON file to `/workspace/ipc/tasks/`:

```json
{
  "type": "spawn_agent",
  "prompt": "...",
  "scope": "admin",
  "timeout": 600000
}
```

---

## Container Setup

One-shot containers are identical to regular agent containers with these differences:

### Workspace

Temporary folder at `data/oneshot/{id}/`:
- Used as `/workspace/group` inside the container
- Agent can create files, notes, scratch work here
- Auto-deleted after `ONESHOT_RETENTION_DAYS` (default: 7)

### Scope

The spawning agent chooses the scope for the one-shot:

| Scope | Rules | Skills | Store | Global memory | Project root |
|-------|-------|--------|-------|--------------|-------------|
| `admin` | core + admin | core + admin | Read-only | Read-write | Read-only |
| `core` | core only | core only | No | Read-only | No |
| `untrusted` | core + untrusted | core + untrusted | No | Read-only | No |

The agent should pick the minimum scope needed for the task. For example:
- Cross-group research (queries messages.db) → `admin`
- Simple text analysis or web research → `core`
- Task on behalf of an untrusted group → `untrusted`

### Mounts

Base mounts (all scopes):
- `/workspace/group` — one-shot's own temp workspace (read-write)
- `/workspace/parent` — **parent group's folder** (read-write, see below)
- `/workspace/global` — global memory (read-only; read-write for `admin`)
- `/workspace/ipc` — IPC namespace (shared with parent group)
- `/home/node/.claude` — sessions + scoped skills

Additional mounts for `admin` scope:
- `/workspace/project` — project root (read-only)
- `/workspace/project/store` — SQLite DB (read-only)

### Parent Group Access

The one-shot mounts the **parent group's folder** at `/workspace/parent/`. This enables a step-by-step workflow:

1. Parent agent writes instructions or context to its group folder (e.g. `/workspace/group/oneshot-task.md`)
2. Parent spawns one-shot agent
3. One-shot reads instructions from `/workspace/parent/oneshot-task.md`
4. One-shot writes results back to `/workspace/parent/results/`
5. Parent agent reads results from its own `/workspace/group/results/`

Both the parent agent and the one-shot can read/write the parent group folder, enabling collaborative multi-step work.

### IPC Namespace

One-shot agents share the IPC namespace of the **parent group**. This means:
- `send_message` sends to the originating chat/thread
- The one-shot cannot register groups or manage tasks (prompt-level restriction, not enforced)

---

## Output Routing

### Progress updates

During execution, the one-shot agent can call `mcp__nanoclaw__send_message()` to send progress updates. These go to the originating chat and thread (the thread where `spawn_agent` was called).

The agent's final text output (the result returned by the container) is also sent to the originating chat/thread — same as regular agents.

### File output

If the task requires writing a report or artifact, the prompt should instruct the agent to write to `/workspace/global/memory/` (accessible by all groups) or `/workspace/group/` (temporary, only accessible to this one-shot).

### Silent mode

If the prompt includes instructions to wrap output in `<internal>` tags, the one-shot runs silently. Useful for background maintenance tasks that write files but don't need to message anyone.

---

## Concurrency

- Multiple one-shots can run in parallel
- They share the `MAX_CONCURRENT_CONTAINERS` limit with regular agents
- Each one-shot gets its own container and workspace
- No queuing per "group" since each one-shot is its own ephemeral group

---

## Timeouts

- Default: 60 minutes (longer than chat agents, since research tasks take time)
- Configurable per spawn via `timeout` parameter
- Same idle-timeout logic applies: container is reaped if no output for `IDLE_TIMEOUT`

---

## Cleanup

A periodic sweep (runs alongside session cleanup) deletes one-shot workspaces older than `ONESHOT_RETENTION_DAYS`:

```
data/oneshot/
  1776003921-abc123/     ← 2 days old, kept
  1775600000-def456/     ← 9 days old, deleted
```

The sweep runs daily. Only the workspace folder is deleted — any files the agent wrote to `/workspace/global/memory/` persist (that's permanent global memory).

---

## Implementation Plan

### Files to modify

| File | Change |
|------|--------|
| `src/ipc.ts` | Add `spawn_agent` IPC case (main-only). Add `spawnAgent` to `IpcDeps`. |
| `src/index.ts` | Implement `spawnAgent` function using existing `runContainerAgent`. Pass as IPC dep. |
| `src/config.ts` | Add `ONESHOT_RETENTION_DAYS`, `ONESHOT_DEFAULT_TIMEOUT` constants. |
| `src/session-cleanup.ts` | Add one-shot workspace sweep to existing cleanup loop. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `spawn_agent` MCP tool (main-only). |

### IPC action schema

```typescript
{
  type: 'spawn_agent';
  prompt: string;                          // What the agent should do
  scope?: 'admin' | 'core' | 'untrusted'; // Default: 'admin'
  timeout?: number;                        // Default: ONESHOT_DEFAULT_TIMEOUT (60 min)
}
```

Host-side handler:
1. Validate `isMain`
2. Generate ID: `{timestamp}-{random}`
3. Create workspace: `data/oneshot/{id}/`
4. Load rules for scope, prepend to prompt
5. Build container mounts:
   - Temp workspace → `/workspace/group`
   - Parent group folder → `/workspace/parent` (read-write)
   - Global memory, store, project root based on scope
6. Spawn `runContainerAgent()` — fire-and-forget (don't await in IPC loop)
7. Route streaming output to originating `chatJid` + `threadId`
8. Log completion

### MCP tool schema

```typescript
server.tool('spawn_agent', '...', {
  prompt: z.string(),
  scope: z.enum(['admin', 'core', 'untrusted']).default('admin'),
  timeout: z.number().optional(),
}, async (args) => {
  // Write IPC file to TASKS_DIR
  // Return immediately with agent ID
});
```

### Container input

Reuses existing `ContainerInput`:
```typescript
{
  prompt: finalPrompt,     // rules + user prompt
  groupFolder: `oneshot/${id}`,
  chatJid: chatJid,        // originating chat (for send_message routing)
  isMain: scope === 'admin',
  threadId: threadId,      // originating thread
  assistantName: ASSISTANT_NAME,
}
```

### Volume mount builder

The `buildVolumeMounts` function needs a new path for one-shot agents. Either:
- A new `buildOneshotMounts(scope, parentGroupFolder)` function
- Or extend `buildVolumeMounts` with an optional `parentGroupFolder` parameter that adds the `/workspace/parent` mount

### Cleanup logic

```typescript
function cleanupOneshotWorkspaces(retentionDays: number): void {
  const oneshotDir = path.join(DATA_DIR, 'oneshot');
  if (!fs.existsSync(oneshotDir)) return;

  const cutoff = Date.now() - retentionDays * 86400_000;
  for (const entry of fs.readdirSync(oneshotDir)) {
    const dir = path.join(oneshotDir, entry);
    const stat = fs.statSync(dir);
    if (stat.isDirectory() && stat.mtimeMs < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
```

---

## Security

- **Main-only**: Only the main group can spawn one-shot agents (enforced at IPC level)
- **No escalation**: One-shot agents cannot register groups, manage tasks, or spawn further one-shots (no IPC tasks directory for one-shots)
- **Scope-based access**: Store and project root only available at `admin` scope. Agent chooses minimum needed scope.
- **Store read-only**: Even at `admin` scope, store is read-only (prevents DB corruption from parallel writes)
- **Parent folder access**: One-shot gets read-write access to the parent group's folder — this is intentional for collaborative workflows. The parent agent controls what's in its folder.
- **Workspace isolation**: Each one-shot gets its own temp folder — no cross-contamination between one-shots
- **Timeout enforced**: Hard timeout prevents runaway containers

---

## Testing

### Unit tests

Test the mount builder and IPC handler without spawning containers:

1. **Mount builder** — verify `buildVolumeMounts` (or the new oneshot variant) produces correct mounts per scope:
   - `admin`: project root, store (read-only), global (read-write), parent folder, temp workspace
   - `core`: global (read-only), parent folder, temp workspace
   - `untrusted`: global (read-only), parent folder, temp workspace
   - All scopes: parent group folder at `/workspace/parent` (read-write)

2. **IPC handler** — verify `spawn_agent` action:
   - Blocked for non-main groups
   - Creates temp workspace directory
   - Passes correct scope/prompt to container runner

3. **Cleanup** — verify `cleanupOneshotWorkspaces`:
   - Deletes folders older than retention period
   - Keeps recent folders

### Integration test (no channels needed)

End-to-end test that spawns a real container, verifiable from the host:

```bash
node --import tsx scripts/test-oneshot.ts
```

The test script:

```typescript
// 1. Setup
//    - Create a fake parent group folder: data/test-parent/
//    - Write instructions: data/test-parent/task.md = "Summarize this"

// 2. Spawn
//    - Call spawnOneshotAgent() directly (imported from src/)
//    - Prompt: "Read /workspace/parent/task.md, write a one-line summary to /workspace/parent/result.txt"
//    - Scope: "core" (no DB needed)
//    - parentGroupFolder: "data/test-parent"

// 3. Wait for completion (await the promise)

// 4. Verify
//    - Assert data/test-parent/result.txt exists
//    - Assert it contains non-empty text
//    - Assert temp workspace data/oneshot/{id}/ was created

// 5. Cleanup
//    - Remove data/test-parent/
//    - Remove data/oneshot/{id}/
```

Run this in CI or locally after implementation. No channels, no user, no chat — just host → container → file → verify.

### CLI smoke test

After `claw oneshot` is implemented:

```bash
# Basic: run a prompt, check exit code
claw oneshot "echo hello" --scope core

# Parent folder: write to parent, verify from host
mkdir -p /tmp/test-parent
claw oneshot "Write OK to /workspace/parent/result.txt" --scope core --parent /tmp/test-parent
cat /tmp/test-parent/result.txt  # should contain "OK"
rm -rf /tmp/test-parent
```

### Manual channel test

After automated tests pass, verify from an actual chat:

1. Send to main group: "spawn an agent to list files in your workspace and report back"
2. Verify: one-shot spawns, progress appears in the same thread, result is delivered
3. Check `data/oneshot/` for the temp workspace

---

## Future Extensions

- **Agent-to-agent**: One-shot agents spawning sub-agents (teams)
- **Result callback**: Structured result returned to the spawning agent via IPC
- **Priority queue**: High-priority one-shots skip the concurrency limit
- **Templates**: Pre-defined one-shot templates for common tasks (daily summary, code review, etc.)
