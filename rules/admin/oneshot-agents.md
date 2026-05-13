# One-Shot Agents — REMOVED

The `mcp__nanoclaw__spawn_agent` tool no longer exists. The whole oneshot infrastructure was removed because:

- Multiple oneshots in the same chat raced each other for the user's IPC input messages, leading to chaotic "all bots respond at once" behaviour.
- Lead had no synchronous way to know when an oneshot finished or what it returned — results came back asynchronously through chat history with `🤖 [oneshot:...]` tags, which is hard to consume reliably.
- The same use cases are covered cleanly by other tools.

## What to use instead

| Old oneshot use case | New approach |
|---|---|
| Delegate a sub-task | `Task(subagent_type: "<persona>", prompt: "...")` — synchronous, returns result directly to you, no chat noise. See `/workspace/global/memory/personas.md` for canonical personas (Researcher, Coder, Architect, Reviewer, Skeptic, PM, Editor, Datawiz, Ops). |
| Cross-group action (post / act in a different chat) | `mcp__nanoclaw__schedule_task(target_group_jid: "<other group's jid>", schedule_type: "once", schedule_value: "<near-term timestamp>", prompt: "...")` — spawns a regular group container under the target group's identity. |
| Long-running async work (don't block) | `mcp__nanoclaw__schedule_task` for a check-back. Pattern: kick off the long work, schedule a check at ETA + buffer, exit your turn. The scheduler wakes you up later. See `rules/core/schedule-checks-instead-of-waiting.md`. |
| Sandbox / scope-downgrade (untrusted code) | Register a separate untrusted-tier group as a helper, delegate via `schedule_task target_group_jid`. Requires one-time setup; rarely needed in practice. |

## Why typed sub-agents work better

`Task(subagent_type: "<name>")` reads `.claude/agents/<name>.md` — frontmatter pins the model (cheap Haiku for Editor/PM, Sonnet for working personas, Opus for Architect/Skeptic), tools allowlist (Researcher gets web tools but not Edit; Coder gets Edit but not Web; etc.), and the system prompt. You don't have to repeat instructions in every spawn prompt — the persona file owns the *how*, you supply the *what*.

To tune a persona's behaviour, edit `.claude/agents/<name>.md` — tools, model, system prompt — and the next spawn picks it up immediately.

## If you see `spawn_agent` in older instructions

Older docs and per-group `CLAUDE.md` files may still reference `spawn_agent` or oneshots. Treat those references as obsolete; substitute with the patterns above.
