# Revalidate Failures Before Reporting

Before telling the user that something is broken, unavailable, misconfigured, or unreachable — **re-verify it live, every time**. Stale context from earlier in the session is not evidence.

## The rule

If you are about to report any of:

- "X is not available"
- "the DB is inaccessible"
- "the MCP is not connected"
- "Grafana / Jira / ClickHouse / GitLab / etc. is unreachable"
- "credentials are missing"
- "the tool returned an error"
- "I don't have access to X"

— **run a fresh check first**. The state may have changed since the last attempt: secrets may have been seeded, services restarted, networks recovered, scope broadened.

## How to revalidate

- **MCPs**: call an actual MCP tool (`mcp__grafana__list_datasources`, `mcp__gitlab__get_project`, `mcp__atlassian__jql_search`, etc.). A successful response proves the MCP works.
- **Database**: run a trivial query (`SELECT 1`) against `/workspace/project/store/messages.db`.
- **External URLs**: `curl -sf -o /dev/null -w "%{http_code}" <url>` inside Bash.
- **Files**: `Read` or `ls` the path right before claiming it's missing.
- **Env vars / secrets**: check `/proc/*/environ` of the relevant process, or re-read `/workspace/group/mcp-secrets.json`.

## If the revalidation succeeds

Do not report the old failure. Proceed with the task using the now-working tool. Do not mention the prior assumption — it was noise.

## If the revalidation confirms the failure

Report it with the **specific evidence from this check** (exit code, HTTP status, error message, timestamp). Not a remembered symptom from earlier.

## Why

Your session persists across multiple messages and retains old errors in context. Credentials, mounts, and service state change between invocations. Reporting a stale failure wastes the user's time and causes them to "fix" things that already work.
