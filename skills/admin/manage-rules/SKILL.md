---
name: manage-rules
description: Add, update, or remove scoped rules and skills via IPC. Main group only.
---

# /manage-rules — Manage Rules and Skills

Add, update, or remove rules (prompt instructions) and skills (slash commands) across four tiers.

## Tiers

| Tier | Loaded for |
|------|------------|
| `core` | All trust levels |
| `trusted` | main + trusted |
| `admin` | main only (e.g. rule management, one-shot use) |
| `untrusted` | untrusted only (security-hardened) |

## Rules

Rules are injected into every agent prompt for the applicable tier. Takes effect on next message.

```
mcp__nanoclaw__add_rule(scope, name, content)   # add or overwrite
mcp__nanoclaw__remove_rule(scope, name)          # delete
```

`scope` is one of `core | trusted | admin | untrusted`.

## Skills

Skills are slash commands synced into the container's `.claude/skills/` at container launch. Takes effect on next container start.

```
mcp__nanoclaw__add_skill(scope, name, files)    # files = { "SKILL.md": "..." }
mcp__nanoclaw__remove_skill(scope, name)         # delete
```

## Inspect current rules/skills

```bash
for tier in core trusted admin untrusted; do
  echo "=== rules/$tier ==="; ls /workspace/project/rules/$tier/ 2>/dev/null
  echo "=== skills/$tier ==="; ls /workspace/project/skills/$tier/ 2>/dev/null
done
```

## Name rules

Names must match `[a-zA-Z0-9][a-zA-Z0-9._-]*` — no spaces, no slashes.

## Registering / promoting groups

Use `mcp__nanoclaw__register_group(jid, name, folder, trigger, trusted)` to register a new group or promote an existing one to trusted. Examples:

- **New trusted group**: `register_group(..., trusted: true)` — the host auto-copies `mcp-secrets.json` from your main group's folder so external MCPs (Grafana, GitLab, Atlassian, ClickHouse) work immediately.
- **Promote existing untrusted → trusted**: same call with the existing JID. If the group folder already has `mcp-secrets.json`, it is preserved (per-group overrides supported). If missing, it's seeded.
- **Different credentials for a specific trusted group**: write `groups/{folder}/mcp-secrets.json` manually BEFORE calling `register_group(trusted: true)`, or edit it after. The seeding only runs when the file is absent.

Untrusted groups never get external MCPs started, so they never need `mcp-secrets.json`.
