# Trust Groups

> Three-tier trust model for NanoClaw container groups: **main**, **trusted**, **untrusted**.

Each group has a trust level that controls which rules, skills, tools, and MCP servers the agent inside its container gets. The three tiers stack: core content applies everywhere; trusted content adds on top for trusted+main; admin content is main-only.

---

## Trust Levels

Trust is derived from `RegisteredGroup`, not stored as a separate column:

```typescript
function getTrustLevel(group: RegisteredGroup): 'main' | 'trusted' | 'untrusted' {
  if (group.isMain) return 'main';
  if (group.containerConfig?.trusted) return 'trusted';
  return 'untrusted';
}
```

- **main** — your control group. Exactly one per installation. Full access.
- **trusted** — groups you fully control (private family/team chats). Elevated access but cannot manage rules/skills/groups.
- **untrusted** — public-ish groups where participants may be adversarial. Restricted, security-hardened.

## Capability Matrix

| Capability | Main | Trusted | Untrusted |
|-----------|------|---------|-----------|
| Project root filesystem | Read-only | None | None |
| SQLite `messages.db` | Read-write | None | None |
| Global memory (`/workspace/global/`) | Read-write | Read-only | Read-only |
| Group folder (`/workspace/group/`) | Read-write | Read-write | Read-write |
| Bash, Read, Write, Edit, Glob, Grep | Yes | Yes | Yes |
| WebSearch / WebFetch | Yes | Yes | Yes |
| Task / subagents (TeamCreate) | Yes | Task only | No |
| schedule_task (recurring work) | Yes | Yes | No |
| send_message to other groups | Yes | Own group only | Own group only |
| Register groups (`register_group`) | Yes | No | No |
| Manage rules/skills (`add_rule`, etc.) | Yes | No | No |
| Spawn one-shot agents (`spawn_agent`) | Yes | No | No |
| `mcp__nanoclaw__*` | All tools | All tools | send_message, list_tasks only |
| External MCPs (Jira, Grafana, ClickHouse, GitLab) | Yes | Yes | No |
| Rules loaded | core + trusted + admin | core + trusted | core + untrusted |
| Skills loaded | core + trusted + admin | core + trusted | core + untrusted |
| CLAUDE.md template | `groups/main/` | `groups/global/` | `groups/untrusted/` |

## Rules

Directory layout (`rules/`):

```
rules/
  core/         # Loaded by all trust levels
  trusted/     # Loaded by main + trusted
  admin/       # Loaded by main only (rule management, oneshot usage, etc.)
  untrusted/   # Loaded by untrusted only (security-restricted)
```

`rules-loader.ts` reads all `.md` files from applicable tiers, concatenates them, and the host prepends the combined text as `<system_rules>` to each agent prompt.

### What goes where

- **core** — universal rules (tone, language matching, query size limits, context recovery, ground-truth verification)
- **trusted** — elevated responsibilities (global memory writes, knowledge base ownership, integration-specific conventions)
- **admin** — only meaningful for main (managing rules, using one-shot agents responsibly)
- **untrusted** — security-defensive rules (decline cross-group requests, don't reveal internals)

### Rules take effect on the next message

The host re-reads rule files every time it builds a prompt. No restart needed after editing.

## Skills

Directory layout (`skills/`):

```
skills/
  core/         # All trust levels (agent-browser, capabilities, slack-formatting, status)
  trusted/      # Main + trusted (daily-summary, nanoclaw-backlog)
  admin/        # Main only (manage-rules)
  untrusted/    # Untrusted only
```

`buildVolumeMounts` copies the applicable tiers into the group's `.claude/skills/` directory before container launch. Skills take effect on the **next container start** (not next message).

### Adding a skill from chat (main only)

```
mcp__nanoclaw__add_skill(
  scope: "core" | "trusted" | "admin" | "untrusted",
  name: "my-skill",
  files: { "SKILL.md": "---\nname: my-skill\n..." }
)
```

## Tools and MCP Servers

`container/agent-runner/src/index.ts` has three per-trust-level allowlists:

```typescript
const TOOLS_BY_TRUST = {
  main:      [/* full list incl. external MCPs */],
  trusted:   [/* no external MCPs, no group registration */],
  untrusted: [/* read-mostly, minimal MCP */],
};
```

MCP server selection: external MCPs (Atlassian, Grafana, ClickHouse, GitLab) are registered for **main and trusted**. Untrusted groups get only the built-in `nanoclaw` MCP.

Trusted groups read secrets from their own `groups/{folder}/mcp-secrets.json` — so different trusted groups can have different API tokens. Untrusted groups never get the file populated.

The `ipc-mcp-stdio.ts` reads `NANOCLAW_TRUST_LEVEL` from env and sets `isMain` / `isTrusted` accordingly. Every privileged operation (register_group, add_rule, spawn_agent, etc.) guards on `isMain` or `isTrusted`.

## Registration and Promotion

### Registering a new group (main agent only)

```
mcp__nanoclaw__register_group(
  jid: "tg:-1001234567890",
  name: "Dev Team Chat",
  folder: "telegram_dev-team",
  trigger: "@andy",
  requiresTrigger: true,
  trusted: true    // ← explicit opt-in; default is false (untrusted)
)
```

New groups default to **untrusted** unless the main agent explicitly sets `trusted: true`.

### Promoting / demoting an existing group

Re-call `register_group` with the same JID and a different `trusted` value. The host merges the `trusted` flag into the stored `containerConfig` while preserving `isMain`.

**There is no way to set `isMain` via MCP** — that flag can only be set by host-side configuration (prevents privilege escalation from chat).

### Template selection at registration

When a group folder is created for the first time, its `CLAUDE.md` is seeded from:

| Trust | Template source |
|-------|-----------------|
| main | `groups/main/CLAUDE.md` |
| trusted | `groups/global/CLAUDE.md` (default identity) |
| untrusted | `groups/untrusted/CLAUDE.md` (security-hardened identity) |

## One-Shot Agents

The `spawn_agent` MCP tool accepts `scope: admin | trusted | untrusted` which directly maps to a trust level for the spawned container. See [docs/oneshot-agents.md](./oneshot-agents.md) for details.

## Migration

Existing non-main groups become **untrusted** by default (the `trusted` field is absent in their `containerConfig`, which `getTrustLevel()` reads as falsy → untrusted).

To promote an existing group to trusted, re-register it with `trusted: true`.

## Security Boundary

The important invariants:

1. **Only main can write to rules/skills** — IPC handlers for `add_rule`, `remove_rule`, `add_skill`, `remove_skill` check `isMain` before executing.
2. **Only main can register/promote groups** — the `register_group` IPC handler checks `isMain`. Trusted agents cannot promote untrusted groups.
3. **Only main can spawn one-shots** — `spawn_agent` IPC + MCP both check `isMain`.
4. **Untrusted groups see no secrets** — external MCPs aren't registered; `groups/*/mcp-secrets.json` is not mounted into their containers' readable paths.
5. **IPC identity is directory-based** — the host derives trust from the IPC directory path (`data/ipc/{folder}/`), which containers cannot forge.

## Files

| File | Role |
|------|------|
| `src/types.ts` | `ContainerConfig.trusted?: boolean` |
| `src/container-runner.ts` | `getTrustLevel()`, `SKILL_TIERS`, `buildVolumeMounts`, `buildOneshotMounts` |
| `src/rules-loader.ts` | `loadRules(trustLevel)`, `TIERS_BY_TRUST` mapping |
| `src/index.ts` | Uses `getTrustLevel(group)` for prompt rules; selects CLAUDE.md template by trust |
| `src/ipc.ts` | `register_group` accepts `trusted` param; trust-aware validation |
| `container/agent-runner/src/index.ts` | `TOOLS_BY_TRUST`, MCP server selection by `trustLevel` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Exposes `register_group` (with `trusted` arg), all IPC-writer MCP tools; reads `NANOCLAW_TRUST_LEVEL` |
| `groups/untrusted/CLAUDE.md` | Security-hardened identity template |
| `rules/{core,trusted,admin,untrusted}/*.md` | Rule content |
| `skills/{core,trusted,admin,untrusted}/` | Skill content |
