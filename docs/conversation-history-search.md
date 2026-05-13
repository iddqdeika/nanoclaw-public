# Conversation History Search

> Design research for giving agents the ability to search through conversation history. Main groups search all groups; non-main groups search only their own.

---

## Problem

Non-main group agents have no way to search past messages beyond their own session context and `conversations/` archive files. The main group can query SQLite directly but has no dedicated tool — it relies on ad-hoc `sqlite3` shell commands. There is no structured, permission-aware search API.

**Current search capabilities by layer:**

| Layer | Main Group | Non-Main Group | Cross-Group |
|-------|-----------|----------------|-------------|
| Current prompt (last ~10 messages) | Yes | Yes | No |
| Session JSONL (memory within session) | Yes | Yes | No |
| `conversations/` archive files | Yes (Grep) | Yes (Grep) | No |
| Custom knowledge files | Yes | Yes | No |
| Direct SQLite query | Yes (ad-hoc) | No | Main only |

**Goal:** A `search_history` MCP tool available to all agents with correct scoping.

---

## Approach Options

### Option A: New MCP Tool in `ipc-mcp-stdio.ts`

Add a `search_history` tool to the existing NanoClaw MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`). The tool writes an IPC request to the host, and the host queries SQLite and writes the result back.

**Pros:**
- Consistent with existing MCP patterns (`schedule_task`, `list_tasks`, etc.)
- Permission model already exists (main vs non-main scoping)
- No new dependencies or servers

**Cons:**
- IPC is file-based and one-directional — no built-in request/response mechanism
- Would need a new response directory and polling loop, adding complexity
- Latency: file poll (1s) + query + file poll (500ms) = 2-3s minimum

**Verdict:** Awkward. IPC is designed for fire-and-forget operations, not request/response.

### Option B: HTTP Endpoint on the Credential Proxy

Add a `/history/search` route to the credential proxy server (`src/credential-proxy.ts`, port 3001). Containers already have network access to the proxy via `ANTHROPIC_BASE_URL`. The proxy runs on the host and can query SQLite directly.

**Pros:**
- Synchronous request/response — natural for search
- No new ports or services — reuses existing proxy infrastructure
- Container already has network access (`http://host.docker.internal:3001`)
- Sub-100ms latency for local SQLite queries

**Cons:**
- Mixes concerns: credential proxy now also serves data queries
- No permission scoping — any container could query any group's messages
- Requires the agent to use `curl` or `WebFetch` — not a native MCP tool

**Verdict:** Fast and simple, but the agent experience is poor (raw HTTP vs tool call).

### Option C: HTTP Endpoint + MCP Tool (Recommended)

Combine B's HTTP endpoint with A's MCP tool interface:

1. **Host side:** Add a lightweight history API server (new module `src/history-api.ts`) bound to the same host as the credential proxy. Could run on a separate port (e.g., 3002) or share port 3001 with path-based routing.

2. **Container side:** Add a `search_history` tool to the NanoClaw MCP server (`ipc-mcp-stdio.ts`). Instead of IPC files, the tool makes an HTTP request to the host's history API and returns the result synchronously.

3. **Permission:** The HTTP request includes the caller's `chatJid` and `isMain` flag (from MCP server environment). The host API enforces scoping:
   - Main group: can search all groups
   - Non-main group: can only search messages where `chat_jid` matches their own JID

**Pros:**
- Clean agent experience: `mcp__nanoclaw__search_history(query: "budget", limit: 20)`
- Synchronous request/response with low latency
- Permission enforced server-side
- Separable from credential proxy

**Cons:**
- New HTTP server/port to manage
- Container needs network access to the new port

**Verdict:** Best overall. Clean interface, correct permissions, good performance.

### Option D: Direct SQLite Access for All Groups

Mount `store/messages.db` read-only into all containers (not just main). Add a container skill that teaches the agent how to query it with `sqlite3`.

**Pros:**
- Zero new code — just a mount and a skill
- Full SQL flexibility
- Instant queries

**Cons:**
- **Security:** Non-main groups could read all groups' messages (SQLite has no row-level security)
- Requires `sqlite3` CLI in the container image (currently not installed; `better-sqlite3` is Node-only)
- No permission scoping without a wrapper
- Concurrent reads while host writes — SQLite default journal mode serializes access, risking `SQLITE_BUSY` errors (WAL mode is not enabled)

**Verdict:** Rejected for non-main groups due to security. Already works for main group.

### Option E: SQLite in Container with Filtered Export

Host periodically exports each group's messages to a per-group SQLite file (e.g., `groups/{folder}/history.db`). Mount read-only into the group's container.

**Pros:**
- Full SQL flexibility within the group
- No cross-group data leakage
- No new HTTP servers

**Cons:**
- Export lag — messages aren't searchable until next export
- Storage duplication (full DB per group)
- Requires `sqlite3` CLI in container or a Node.js query script
- Export job adds complexity and maintenance burden

**Verdict:** Possible but over-engineered for the benefit.

---

## Recommended Design: Option C

### Architecture

```
Container                              Host
┌──────────────────────┐       ┌───────────────────────┐
│  Agent calls          │       │                       │
│  search_history()     │       │  history-api.ts       │
│       │               │       │  (port 3002)          │
│       ▼               │       │       │               │
│  ipc-mcp-stdio.ts    │──HTTP──▶  Validates caller    │
│  (MCP server)        │       │  Queries SQLite       │
│       │               │       │  Returns results      │
│       ▼               │◀─JSON──│                       │
│  Returns to agent     │       │                       │
└──────────────────────┘       └───────────────────────┘
```

### MCP Tool Interface

```typescript
// Tool: search_history
{
  name: "search_history",
  description: "Search conversation history across messages. Main group searches all groups; non-main searches own group only.",
  inputSchema: {
    type: "object",
    properties: {
      query:      { type: "string",  description: "Search text (substring match)" },
      sender:     { type: "string",  description: "Filter by sender name (optional)" },
      since:      { type: "string",  description: "ISO 8601 timestamp — only messages after this time (optional)" },
      until:      { type: "string",  description: "ISO 8601 timestamp — only messages before this time (optional)" },
      group_name: { type: "string",  description: "Filter by group name (main group only, optional)" },
      limit:      { type: "number",  description: "Max results (default 20, max 100)" },
    },
    required: ["query"]
  }
}
```

### Host API Endpoint

```
GET http://host.docker.internal:3002/search
  ?query=budget
  &sender=Alice
  &since=2026-03-01T00:00:00
  &limit=20
Headers:
  X-NanoClaw-JID: tg:434532334
  X-NanoClaw-IsMain: 1
```

### SQL Query (Host Side)

The query is built dynamically with parameterized placeholders. Filters are appended only when the corresponding parameter is provided.

```sql
SELECT m.sender_name, m.content, m.timestamp, c.name AS group_name
FROM messages m
LEFT JOIN chats c ON m.chat_jid = c.jid
WHERE m.content LIKE '%' || ?1 || '%'
  AND m.is_bot_message = 0
ORDER BY m.timestamp DESC
LIMIT ?2
```

**Conditional clauses (appended server-side):**

| Condition | Clause | When |
|-----------|--------|------|
| Permission (non-main) | `AND m.chat_jid = ?` | Always for non-main callers |
| Sender filter | `AND m.sender_name = ?` | `sender` param provided |
| Date range (start) | `AND m.timestamp > ?` | `since` param provided |
| Date range (end) | `AND m.timestamp < ?` | `until` param provided |
| Group filter | `AND c.name = ?` | `group_name` param provided (main only) |

### Response Format

```json
{
  "results": [
    {
      "sender": "Alice",
      "content": "The Q3 budget is finalized at 50k",
      "timestamp": "2026-03-15T14:30:00.000Z",
      "group": "General"
    }
  ],
  "total": 1,
  "truncated": false
}
```

### Performance: FTS5 vs LIKE

**Current state:** No full-text search index. The `messages` table has an index on `timestamp` only.

**LIKE queries** (`content LIKE '%budget%'`) force a full table scan on the `content` column. For small-to-medium message volumes (under 100k messages) this is fast enough (< 100ms on SSD). For larger volumes, performance degrades linearly.

**SQLite FTS5** would provide instant keyword search:

```sql
-- Create virtual table (migration)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=rowid
);

-- Populate from existing data
INSERT INTO messages_fts(rowid, content)
  SELECT rowid, content FROM messages;

-- Triggers to keep in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

**Recommendation:** Start with LIKE. Add FTS5 migration when message volume exceeds ~50k rows or search latency exceeds 200ms. The LIKE approach requires zero schema changes and is simpler to maintain.

---

## Implementation Plan

### Step 1: Host-side history API (`src/history-api.ts`)

New module exporting `startHistoryApi(port, host)`. Creates an HTTP server with a single `/search` endpoint. Queries SQLite via existing `db.ts` connection. Enforces permission based on `X-NanoClaw-JID` and `X-NanoClaw-IsMain` headers.

### Step 2: Start the API in `src/index.ts`

Call `startHistoryApi()` alongside `startCredentialProxy()` during startup. Pass port from config (new `HISTORY_API_PORT` env var, default 3002).

### Step 3: Container environment

Pass `NANOCLAW_HISTORY_URL=http://{CONTAINER_HOST_GATEWAY}:{HISTORY_API_PORT}` as environment variable to containers (in `src/container-runner.ts`).

### Step 4: MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`

Add `search_history` tool. On invocation, HTTP GET to `NANOCLAW_HISTORY_URL/search` with query params and identity headers. Return formatted results.

### Step 5: Container skill docs

Add a container skill (`container/skills/history-search/SKILL.md`) documenting the tool usage and examples.

### Step 6: Allowed tools

Add `mcp__nanoclaw__search_history` to the allowed tools list in `container/agent-runner/src/index.ts` (already covered by `mcp__nanoclaw__*` wildcard).

---

## Security Considerations

- **Row-level scoping enforced server-side.** The container cannot bypass permission checks — identity comes from environment variables set by the host, not from the container.
- **No write access.** The API is read-only.
- **Query injection.** Use parameterized SQL queries only. Never interpolate user input into SQL strings.
- **Rate limiting.** Not needed initially (containers are short-lived), but could be added if agents loop on search queries.
- **Content exposure.** Main group agents can see all messages across all groups. This is intentional and consistent with existing main group privileges (direct SQLite mount).

---

## Alternatives Considered and Rejected

| Approach | Why Rejected |
|----------|-------------|
| Direct SQLite for all groups | Cross-group data leakage — no row-level security |
| Per-group SQLite exports | Storage duplication, export lag, maintenance overhead |
| IPC file-based request/response | Too slow (2-3s), not designed for request/response |
| Elasticsearch/external search | Over-engineered for single-user personal assistant |
| Embedding-based semantic search | Complexity and cost don't justify the benefit for exact/keyword search |
| Credential proxy route extension | Mixes concerns; agent experience poor (raw HTTP) |
