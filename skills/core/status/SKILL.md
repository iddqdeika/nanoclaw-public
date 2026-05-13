---
name: status
description: Quick read-only health check — session context, workspace mounts, tool availability, and task snapshot. Use when the user asks for system status or runs /status.
---

# /status — System Status Check

Generate a quick read-only status report of the current agent environment.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/status` there to check system status.

Then stop — do not generate the report.

## How to gather the information

Run the checks below and compile results into the report format.

### 1. Session context

```bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"
echo "Channel: main"
```

### 2. Workspace and mount visibility

```bash
echo "=== Workspace ==="
ls /workspace/ 2>/dev/null
echo "=== Group folder ==="
ls /workspace/group/ 2>/dev/null | head -20
echo "=== Extra mounts ==="
ls /workspace/extra/ 2>/dev/null || echo "none"
echo "=== IPC ==="
ls /workspace/ipc/ 2>/dev/null
```

### 3. Tool availability

Confirm which tool families are available to you:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **MCP:** mcp__nanoclaw__* (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group)

### 4. Container utilities

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not installed"
node --version 2>/dev/null
claude --version 2>/dev/null
```

### 5. Task snapshot

Use the MCP tool to list tasks:

```
Call mcp__nanoclaw__list_tasks to get scheduled tasks.
```

If no tasks exist, report "No scheduled tasks."

### 6. Token usage (main group only)

Call `mcp__nanoclaw__get_usage_metrics` to retrieve daily token totals for the current group over the last 7 days. Include:
- Today's turns + total input tokens + output tokens
- 7-day totals + average context size per turn
- Any day with notably higher usage (outlier)

If the tool isn't available (non-main groups), skip this section silently.

## Report format

Present as a clean, readable message:

```
🔍 *NanoClaw Status*

*Session:*
• Channel: main
• Time: 2026-03-14 09:30 UTC
• Working dir: /workspace/group

*Workspace:*
• Group folder: ✓ (N files)
• Extra mounts: none / N directories
• IPC: ✓ (messages, tasks, input)

*Tools:*
• Core: ✓  Web: ✓  Orchestration: ✓  MCP: ✓

*Container:*
• agent-browser: ✓ / not installed
• Node: vXX.X.X
• Claude Code: vX.X.X

*Scheduled Tasks:*
• N active tasks / No scheduled tasks

*Token Usage (7d):*
• Today: N turns · in ~X / out Y · avg per-call ctx ~Z / peak ctx P
• Week: N turns · total in X · total out Y
• Peak single-call context: X tokens (YYYY-MM-DD)
```

**Context length interpretation.** `total_input_tokens` is the SUM across all API calls in a turn — not the context window size. The real "how close to the 200K limit" is `max_context_tokens` (biggest single call's input) and `avg_context_tokens` (average call size within the turn). Surface both if available.

Adapt based on what you actually find. Keep it concise — this is a quick health check, not a deep diagnostic.

**See also:** `/capabilities` for a full list of installed skills and tools.
