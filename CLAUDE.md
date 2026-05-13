# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.


## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

**Memory model uses a pending-confirmation flow** (see `rules/core/memory.md`, `rules/admin/pending-confirmations.md`): writes to `/workspace/global/memory/` from any tier (admin or trusted) start as `status: unconfirmed` and are gated by recall discipline until an admin/is_main agent in the same messenger explicitly approves them. This skill is `/add-pending-memory-flow`.

**Agent swarms** are supported on Slack (`/add-slack-swarm` — uses native `chat.postMessage` with per-call `username`/`icon_emoji`) and Telegram (`/add-telegram-swarm` — uses a pool of BotFather bots renamed at runtime via `setMyName`). Both share a common subagent contract — `mcp__nanoclaw__send_message(text, sender, icon_emoji?)` — and both consume the persona library at `/workspace/global/memory/personas.md` (`/add-persona-library`).

**Auto-recovery for failed turns** (`/add-recovery-system`): on any error from the agent's container (network drop, Anthropic 5xx, rate-limit, auth expired, container crash, idle-timeout), the orchestrator classifies the error and schedules an adaptive retry. Background sweep retries up to a 24h budget per error type; boot hook resumes pending turns after `pm2 restart`. Silent during retry; on give-up, posts `❌ Не справился...` + `cancel` reaction on the original trigger message. Test harness: `simulate_failure(error_type)` MCP tool (admin only) + `docs/RECOVERY-TESTING.md`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/mcp-gateway/` | Host-side MCP proxy (A/B per group via `containerConfig.useMcpGateway`). See [`docs/MCP-GATEWAY.md`](docs/MCP-GATEWAY.md). Add new MCPs via `/add-mcp-to-gateway`. |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `skills/{core,trusted,admin,untrusted}/` | Tier-scoped skills synced into agent containers (browser, status, formatting) |
| `rules/{core,trusted,admin,untrusted}/` | Tier-scoped markdown rules injected into agent prompts |
| `personas/*.md` | Typed sub-agent definitions for `Task(subagent_type: "<name>")` swarm spawning. Synced into each container's `.claude/agents/` (status: confirmed only). See [`rules/core/persona-creation.md`](rules/core/persona-creation.md) for `add_persona`/`update_persona`/`delete_persona` MCP tools. |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`skills/{tier}/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/add-mcp` | Add an MCP via the direct in-container path |
| `/add-mcp-to-gateway` | Add an MCP via the host-side gateway (preferred for credentialed servers) |
| `/add-pending-memory-flow` | Pending-confirmation flow for global memory (writes start `unconfirmed`; admin/is_main confirms; trusted gains rw on global) |
| `/add-persona-library` | Install canonical persona library at `groups/global/memory/personas.md` (Researcher, Coder, Architect, Reviewer, Skeptic, PM, Editor, Datawiz, Ops) |
| `/add-slack-swarm` | Agent teams in Slack via per-message `username` + `icon_emoji` (no bot pool; needs `chat:write.customize`) |
| `/add-telegram-swarm` | Agent teams in Telegram via a pool of pre-created bots that get renamed at runtime |
| `/add-recovery-system` | Auto-recovery for failed turns: classify error → adaptive retry up to 24h via background sweep + boot hook. Includes `simulate_failure` MCP for testing. |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
