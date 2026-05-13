# Tessl Tiles Integration Research

> How tessl tiles work, what they provide, and how to integrate them into NanoClaw.

Based on analysis of [jbaruch/nanoclaw-public](https://github.com/jbaruch/nanoclaw-public).

---

## What Are Tessl Tiles?

Tessl is a registry and delivery platform for packaging agent rules and skills into versioned, installable bundles called **tiles**. Each tile is a directory containing:

- `tile.json` — manifest with name, version, summary, and references to rules/skills
- `rules/` — markdown files injected as behavioral rules into the agent's context
- `skills/` — Claude Code skills (SKILL.md files) loaded into the agent's skill system

Tiles are published to the tessl registry (`tessl.io`), versioned independently, and installed into containers at runtime. The key value proposition: **different trust levels of chat groups get different tile sets**, enforcing a security boundary through capability separation.

---

## The Five-Tile Architecture

The jbaruch fork uses five tiles arranged in a trust hierarchy:

```
                    ┌──────────────────┐
                    │  nanoclaw-host   │  Host agent only (Claude Code on Mac)
                    └──────────────────┘
                    ┌──────────────────┐
                    │  nanoclaw-admin  │  Main channel only
                    └──────────────────┘
                    ┌──────────────────┐
                    │ nanoclaw-trusted │  Trusted + main channels
                    └──────────────────┘
                    ┌──────────────────┐
                    │  nanoclaw-core   │  All containers
                    └──────────────────┘
  ┌──────────────────┐
  │nanoclaw-untrusted│  Untrusted containers only
  └──────────────────┘
```

### Tile Contents Summary

| Tile | Loaded For | Rules | Skills | Purpose |
|------|-----------|-------|--------|---------|
| `nanoclaw-core` | All containers | 11 | 2 | Identity, communication, formatting, silence, temporal awareness, verification |
| `nanoclaw-trusted` | Trusted + main | 7 | 3 | Shared memory, session bootstrap, system health, operational discipline |
| `nanoclaw-admin` | Main only | 4 | 20 | Group management, scheduling, external APIs, calendar, email, tile promotion |
| `nanoclaw-untrusted` | Untrusted only | 2 | 1 | Credential protection, social engineering defense, code execution refusal |
| `nanoclaw-host` | Host agent | 1 | 4 | Tile promotion pipeline, container management, staging checks |

### Trust Level Assignment

Groups are assigned a trust level at registration time via `containerConfig`:

- **Main** (`isMain: true`) — gets core + trusted + admin tiles
- **Trusted** (`containerConfig: { trusted: true }`) — gets core + trusted tiles
- **Untrusted** (no containerConfig) — gets core + untrusted tiles

---

## tile.json Manifest Format

Each tile has a `tile.json` at its root:

```json
{
  "name": "nanoclaw/nanoclaw-core",
  "version": "0.1.39",
  "summary": "Core behavioral rules and skills for NanoClaw agents.",
  "private": false,
  "rules": {
    "core-behavior": { "rules": "rules/core-behavior.md" },
    "language-matching": { "rules": "rules/language-matching.md" }
  },
  "skills": {
    "status": { "path": "skills/status/SKILL.md" }
  }
}
```

Fields:
- **name**: `{publisher}/{tile-name}` format (e.g., `jbaruch/nanoclaw-core`)
- **version**: semver-style (e.g., `0.1.39`)
- **summary**: description used by the registry
- **private**: if `true`, only the publisher can install it
- **rules**: map of rule name to file path (relative to tile root)
- **skills**: map of skill name to SKILL.md path (relative to tile root)

---

## Workspace Configuration

The orchestrator declares tile dependencies in `tessl-workspace/tessl.json`:

```json
{
  "name": "nanoclaw-orchestrator",
  "mode": "managed",
  "dependencies": {
    "jbaruch/nanoclaw-core": { "version": "0.1.60" },
    "jbaruch/nanoclaw-admin": { "version": "0.1.101" },
    "jbaruch/nanoclaw-untrusted": { "version": "0.1.15" },
    "jbaruch/nanoclaw-trusted": { "version": "0.1.30" },
    "jbaruch/nanoclaw-host": { "version": "0.1.2" }
  }
}
```

The `mode: "managed"` flag means tessl handles installation and updates. In the jbaruch fork, installed tiles land at `/home/node/.claude/.tessl/tiles/*/` inside containers. Our codebase has no tessl integration — container skills are copied to `/home/node/.claude/skills/` from host-side `container/skills/`.

---

## How Tiles Map to NanoClaw Concepts

### Rules vs Skills

| Tessl Concept | NanoClaw Equivalent | How It Works |
|---------------|-------------------|-------------|
| **Rules** | Behavioral instructions appended to agent context | Markdown files loaded as system-level guidance — always active, not invocable |
| **Skills** | Container skills (`container/skills/*/SKILL.md`) | Claude Code skills with frontmatter — invocable by name or pattern match |

### Current NanoClaw Skill System

NanoClaw already has a skill distribution mechanism:

1. **Container skills** live in `container/skills/` on the host
2. At container startup, `container-runner.ts` copies them into each group's `.claude/skills/` directory
3. All groups get the same skills — **no trust-level differentiation**

### What Tiles Add

1. **Trust-based skill selection** — different groups get different capabilities
2. **Versioned delivery** — tiles are versioned and published to a registry, enabling rollback and audit
3. **Rules as a first-class concept** — behavioral guidance separate from invocable skills
4. **A promotion pipeline** — skills are staged, reviewed, and promoted through a structured workflow

---

## Tile Promotion Pipeline

The jbaruch fork has a multi-stage promotion workflow for updating tiles:

```
Agent creates/modifies skill in staging
         │
         ▼
Container agent runs promote-tiles skill
         │
         ▼
MCP tool: promote_staging(tile_name)
         │
         ▼
Host agent: scripts/promote-skill.sh
  1. Pull latest from git
  2. Optimize and lint
  3. Commit and push
  4. Publish to tessl registry
  5. Install updated tile
         │
         ▼
20-min delay (tessl review + optimize pipeline)
         │
         ▼
verify-tiles skill confirms installation matches staging
```

The **skill-tile-placement** rule provides a decision checklist:

| Condition | Target Tile |
|-----------|-------------|
| Requires external API credentials | admin |
| Manages NanoClaw infrastructure | admin |
| Only meaningful in main channel | admin |
| Reads/writes shared memory (`/workspace/trusted/`) | trusted |
| Operational behavior for trusted containers | trusted |
| Needed by all containers, no external APIs | core |
| Security restriction for untrusted containers | untrusted |

Default if uncertain: **admin** (safest — restricts to main channel only).

---

## Integration Options for Our NanoClaw

### Option A: Full Tessl Integration

Use the tessl platform as-is. Publish our own tiles to the registry, configure `tessl.json`, and let tessl handle delivery.

**What's needed:**
1. Create a tessl account and workspace
2. Create tile directories with `tile.json` manifests
3. Add `tessl-workspace/tessl.json` to declare dependencies
4. Modify `container-runner.ts` to pass tile selection env vars based on group trust level
5. Install the tessl CLI in the container image
6. The container needs network access to `tessl.io` to pull tiles at startup

**Pros:**
- Full versioning, registry, rollback support
- Structured promotion pipeline
- Matches the jbaruch fork's architecture closely

**Cons:**
- External dependency on tessl.io (availability, latency at container startup)
- Requires tessl account and learning the tessl CLI
- Container startup latency increases (tile download on each run)
- Over-engineered if we don't need the registry/versioning workflow

### Option B: Trust-Based Skill Selection Without Tessl (Recommended)

Implement the trust-level differentiation natively using NanoClaw's existing skill distribution. No external registry — tiles are just directories on disk.

**What's needed:**
1. Restructure `container/skills/` into trust tiers:
   ```
   container/skills/
     core/           # All containers
     trusted/        # Trusted + main
     admin/          # Main only
     untrusted/      # Untrusted only
   ```
2. Add a `trust` field to `RegisteredGroup` (or use existing `containerConfig`)
3. Modify `container-runner.ts` skill copy logic to select skills based on trust level
4. Optionally add a `rules/` directory per tier for behavioral rules (appended to the group's CLAUDE.md or loaded as separate skill files)

**Pros:**
- No external dependencies
- Zero startup latency — skills copied from local disk
- Uses existing infrastructure (skill copy in container-runner.ts)
- Simple to understand and maintain

**Cons:**
- No versioning or registry (but git provides version history)
- No structured promotion pipeline (but can use git branches)
- Manual sync when updating skills across tiers

### Option C: Hybrid — Local Tiles with tile.json Manifests

Use the tile.json manifest format for organization but skip the tessl registry. Tiles are local directories with manifests, selected by trust level at container startup.

**What's needed:**
1. Create a `tiles/` directory with the five-tile structure
2. Each tile has `tile.json`, `rules/`, `skills/`
3. Modify `container-runner.ts` to read tile manifests and copy the right tiles based on group trust level
4. Rules from tiles are concatenated and mounted as additional context

**Pros:**
- Organized structure with manifests
- Compatible with tessl if we want to publish later
- Local-only, no external dependencies
- Clear separation of concerns per trust level

**Cons:**
- New manifest parsing code needed
- More complex than Option B for the same result
- tile.json format might drift from tessl's if they change it

---

## Recommendation

**Option B** for now — restructure existing `container/skills/` into trust tiers and modify the skill copy logic in `container-runner.ts`. This gives us the core value (trust-based capability separation) without external dependencies or new infrastructure.

If we later want the registry/versioning/promotion pipeline, we can adopt tessl on top of the same directory structure (Option C as a stepping stone to Option A).

### Implementation Sketch

**1. Add trust level to group config:**

The `containerConfig` field on `RegisteredGroup` already exists (currently holds `additionalMounts` and `timeout`). Extend it with a `trust` enum:
- `"admin"` — main channel (implicit from `isMain`)
- `"trusted"` — trusted groups
- `"untrusted"` — default for all other groups

**2. Restructure container skills:**

```
container/skills/
  core/
    status/SKILL.md
    capabilities/SKILL.md
  trusted/
    (future trusted-only skills)
  admin/
    (future admin-only skills)
  untrusted/
    whoami/SKILL.md
  rules/
    core/
      core-behavior.md
    trusted/
      trusted-behavior.md
    admin/
      admin-context.md
    untrusted/
      untrusted-security.md
```

**3. Modify skill copy in `container-runner.ts`:**

Currently copies all skills from `container/skills/` to the group's `.claude/skills/`. Change to:
- Always copy `core/`
- If trusted or main: also copy `trusted/`
- If main: also copy `admin/`
- If untrusted: also copy `untrusted/`

**4. Mount rules as context:**

Concatenate the relevant `rules/*.md` files and mount as an additional CLAUDE.md include, or append to the group's CLAUDE.md at container startup.

---

## Key Takeaways from the jbaruch Fork

1. **Trust tiers are the core innovation** — not tessl itself. The five-tile split (core/trusted/admin/untrusted/host) is a clean security model that works independently of the delivery mechanism.

2. **Rules are valuable** — behavioral rules (language matching, silence defaults, temporal awareness, tone matching) improve agent quality significantly. These are worth adopting regardless of the tile system.

3. **The untrusted tier is critical** for multi-user groups — credential protection, social engineering defense, and code execution refusal are essential when the agent is exposed to people outside the owner's trust circle.

4. **The promotion pipeline is sophisticated but optional** — useful for a frequently-evolving setup with many skills. For a simpler setup, git branches and manual skill management suffice.

5. **Version skew is real** — the jbaruch fork shows different versions between `tile.json` (source) and `tessl.json` (installed), indicating the registry can lag behind or run ahead of source. This is a maintenance consideration.
