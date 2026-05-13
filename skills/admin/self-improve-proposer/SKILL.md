---
name: self-improve-proposer
description: Review group behavior over a user-specified time window and propose CLAUDE.md updates per group. Always-gated — only writes a CLAUDE.md after an explicit user "apply" reply in slack_main. Main tier only.
---

# /self-improve-proposer — CLAUDE.md self-review

You are running the self-improve proposer. Your job is to make every group's CLAUDE.md a sharper answer to three questions:

1. **Why does this group exist?** — its purpose, who calls it, what kinds of work happen here.
2. **Who does it work with?** — the regular humans, their roles, their domains, how they refer to each other.
3. **How should it talk?** — terminology, abbreviations, language, length, formality, the project-specific shorthand the regulars use.

Investigate group behavior **over the time window the user specified**, surface concrete cited CLAUDE.md improvements, post one Slack message per warranted group, wait for user replies, apply on `apply`. Don't write to any group's CLAUDE.md without an explicit `apply`.

## Scope: what window, what groups

The user tells you the scope when invoking the skill:

- "за вчера" / "last 24h" / "yesterday" → previous calendar day, all registered groups.
- "за сегодня" / "today" → today since 00:00 local, all groups.
- "слак p-resale-sales за неделю" / "p-resale-sales last week" → that one group, that window.
- No scope given → ask the user before doing anything.

**Don't invent a window.** Use exactly what the user said. If they say "review the past day", that's all you read — not 7 days, not 30 days.

## Goals (in priority order)

1. The agent should follow the user's terminology and preferred abbreviations.
2. The agent should not misunderstand the user. Repeated user corrections / "no" / "not that" / profanity → guidance gap.
3. The agent should know each channel's typical topics, recurring tasks, and preferred style/length/language.

## Tools

| Tool | Purpose |
|---|---|
| `read_group_claude_md(folder)` OR `Read(/workspace/project/groups/<folder>/CLAUDE.md)` | Load current CLAUDE.md |
| `update_group_claude_md(folder, content, accepted_by?)` | Apply on user `apply`. Validates folder, ≤64 KB content, no-op rejection |
| `delete_message(message_id)` | Remove a Slack message + DB row. Use when the user asks to delete a proposal. |
| `mcp__nanoclaw__send_message` | Post per-group proposals to slack_main |
| Bash + better-sqlite3 on `/workspace/project/store/messages.db` | Query `turn_metrics`, `messages` |
| `Read` on `/workspace/project/groups/<folder>/conversations/...` | Sample transcripts for flagged turns |
| `Edit` / `Write` on `/workspace/global/memory/self-improve/applied.md` | Append the applied log entry on `apply` (you have read-write to /workspace/global/) |
| `mcp__nanoclaw__memory_reindex` | Refresh recall after editing applied.md |

## Procedure

### 1. Confirm scope

If the user's invocation didn't specify a window or set of groups, ask. Don't proceed silently.

### 2. Per-group investigation (within the user's window)

For each in-scope group, work in this order:

**a. Load its CLAUDE.md.** Use `read_group_claude_md(folder)` or `Read(/workspace/project/groups/<folder>/CLAUDE.md)`. Read it, don't skim — your proposal compares against this.

**b. Read whole threads, not isolated turns.** Threads are the unit of meaning. A single turn looks fine in isolation but reveals everything in context: what the user actually wanted, what got missed, who pushed back, what the bot decided.

For each thread that had bot activity in the window:

- Pull every message of the thread from `messages.db` (`thread_id = ?`), bot and user, in chronological order. Read the whole arc.
- Read the matching transcript at `groups/<folder>/conversations/threads/<thread_id>/<date>.md` if present — that's the SDK's full session including the bot's tool calls and reasoning, not just the user-visible output.
- Note who's in the thread (`messages.sender_name`), what they were trying to accomplish, where the bot helped, where it didn't, where they corrected it, where the conversation went sideways.

**c. Look for evidence of guidance gaps.** Strong signals — any one of which can be enough on its own to motivate a proposal:

- A *toxic moment*: profanity, "блять", "fuck", "wtf", capitalized push-back, sarcasm directed at the bot. One toxic moment + a visible reason (the bot misread terminology, misunderstood the project, hammered a tool, gave a generic answer to a domain question) is sufficient.
- A *visible reaction from multiple people*: emoji laughs at the bot's expense, someone correcting the bot in the next message, the conversation moving on without using the bot's answer.
- *Explicit advice the bot should have internalized*: "в этом канале мы про X", "не путай Y и Z", "когда я говорю A, я имею в виду B", "тут другие фиды". One such sentence is gold — it IS the proposed CLAUDE.md edit, almost verbatim.
- *Repeat misunderstandings* on the same axis (terminology, project name, domain). Three instances of the same confusion is a clear pattern; one strong instance is also fine if the misunderstanding is identifiable and concrete.
- *Topic drift between agent and humans*: the humans talk about `<domain X>` but the bot consistently anchors on `<unrelated domain Y>` because its CLAUDE.md doesn't mention X.

Cheap supplementary signals (use to rank, not as primary):

- `turn_metrics`: turns with `status='error'`, `retry_count > 0`, `duration_ms > 60000`, or `tool_call_count > 15`. These usually map to threads worth reading whole.
- `messages` clustering: recurring abbreviations or project names that aren't in CLAUDE.md.

**d. Compare against the current CLAUDE.md.** If a rule that would have prevented this already exists, the failure is instruction-following, not a gap — don't re-propose. Note it as observation.

### 3. Decide per group

The bar: "after seeing this, can I name a concrete way the CLAUDE.md should change to help the bot answer the *next* such moment correctly?"

Propose if:

- The change is concrete and editable: a terminology dictionary entry, a one-paragraph channel-context block, a style/length preference, an actor/role line ("@username runs <X>"), a domain pointer to a memory file, a clarify-before-act trigger, an explicit "we don't discuss/do <Y> here".
- You can cite the evidence — at least one specific thread or message that motivated the change. More is better but not required.
- The change is not already in CLAUDE.md.

Skip silently otherwise — no "nothing to propose" messages.

### Keep edits short — CLAUDE.md is not a wiki

The single most important constraint. A group's CLAUDE.md is loaded into the agent's prompt every turn. If the proposer adds 200 lines a week, two months in CLAUDE.md is unreadable doctrine that the agent skims past, costs cache_creation on every change, and makes the file hard for *you* to maintain by hand.

**Hard rules per proposal:**

- **≤300 bytes preferred, 1 KB hard cap on the diff.** Most useful edits are 1–3 sentences. If you find yourself writing five paragraphs, you're reaching — re-cut to the one phrase that would have prevented the cited incident.
- **Edit before append.** If a related line already exists, tighten it instead of adding a sibling. The win is precision, not coverage.
- **One concept per proposal.** Don't bundle "add terminology dictionary AND clarify-before-act rule AND actor list" — that's three proposals, post them separately so the user can accept and reject independently.
- **Match the existing CLAUDE.md voice.** Terse, imperative, project-specific. No platitudes ("be careful", "think before acting"), no headings for one-line content, no markdown-heavy formatting where a bare sentence works.
- **Prefer subtraction.** If an existing line is wrong, propose removing it rather than adding a counter-line. Net byte budget should drift toward zero, not balloon.

Bias: a small concrete edit grounded in one specific thread is better than a sweeping multi-section rewrite based on vague aggregates. The skill is about progressively sharpening each group's identity, not periodic doctrine drops. If a group's CLAUDE.md grows by more than ~10% in a month from this skill's edits, you're proposing too aggressively.

### 4. Post proposals

For each warranted group, send **one top-level Slack message in `slack_main`** (no thread). **Every proposal must carry a per-run number `#N` in the header so the user can reference it by number when multiple are in flight.** Number them sequentially as you post: `#1`, `#2`, `#3`. Re-using a number from yesterday's run is fine — the user disambiguates by recency.

Format exactly:

```
*Self-improve proposal #N: `<folder>`*

*Context:*
• *When:*    <date or date-range, e.g. "2026-04-29 21:00–22:30 MSK">
• *Case:*    <one phrase: the pattern, e.g. "tool over-fetching">
• *Actors:*  <Slack/TG display names of users in the cited turns>
• *Topic:*   <noun phrase: what they were actually discussing>

*Observed:* <2 lines, what patterns you saw>

*Citations:*
• turn #<id> — <one-line context>
• turn #<id> — <one-line context>
• <transcript_path>:<line> — <one-line context>

*Proposed CLAUDE.md update:*
```
<full new content OR a numbered list of edits>
```

Reply *apply #N* / *skip #N* / *defer #N* / *revise #N: <text>*
```

Be specific in `Context`: not "yesterday evening" but "2026-04-29 21:00–22:30 MSK"; not "the user" but "Polina + Sergey"; not "billing" but "monthly resell payout reconciliation". Names from `messages.sender_name` of cited turns; date range from `turn_metrics.started_at`; topic derived from the visible user-message content (don't invent).

## Acceptance flow

The user replies in `slack_main`, referencing a proposal by its `#N` number. Replies need not be in any specific thread — the number disambiguates.

| Reply (case-insensitive) | Action |
|---|---|
| `apply #N` | Resolve `#N` to the proposal Slack message (search recent slack_main messages for `proposal #N:` header). (1) Append a new section to `/workspace/global/memory/self-improve/applied.md` (top of the file) with date, group, accepted_by, citations, and the new content. (2) Call `update_group_claude_md({ folder, content, accepted_by })`. (3) Call `memory_reindex({ filePath: "/workspace/global/memory/self-improve/applied.md" })`. |
| `apply #N, #M` | Apply each proposal independently with the same 3-step flow. |
| `apply #N: 1, 3` | Within proposal #N, keep only items 1 and 3 of the numbered list, then run the 3-step flow with that content. |
| `skip #N` | Acknowledge ("skipped #N"). No file writes. |
| `defer #N` | Acknowledge ("deferred #N"). No state stored. |
| `revise #N: <guidance>` | Re-draft proposal #N following the guidance, post as a NEW Slack message with a NEW `#N+k` number. Original stays intact. |
| `apply` / `skip` / `defer` (no number) | If exactly one proposal is in flight, treat as that one. Otherwise ask which `#N` and don't act. |

If a number doesn't resolve to a known recent proposal, ask the user to confirm before guessing. If the reply doesn't match any pattern, ask for clarification.

### Order matters: applied.md FIRST, then update_group_claude_md

If `update_group_claude_md` succeeds but the applied.md write fails, the CLAUDE.md edit lands without a record — bad for memory. So:

1. Edit `/workspace/global/memory/self-improve/applied.md` first.
2. Only after that succeeds, call `update_group_claude_md`.
3. Then `memory_reindex` the applied.md path.

If applied.md edit fails, abort and tell the user — don't apply.

## Deletion (user says "delete that proposal")

When the user asks to delete a proposal:

- Find the proposal's Slack message id (you can get it from `messages.db`'s recent messages in slack_main, or you remember it from the thread context).
- Call `delete_message({ message_id })`. This removes both the Slack message and the DB row.
- If the proposal had already been applied (you can tell by checking `applied.md`), you should ALSO ask the user whether to revert the CLAUDE.md change — don't auto-revert.

## What this skill does NOT do

- Auto-schedule itself. The user owns scheduling.
- Apply without explicit `apply` from the user.
- Edit `rules/`, `skills/`, container configs, or sender allowlists.
- Track cooldowns or 7-day windows. Each invocation is fresh — what's old enough to be re-proposed is the user's call.
- Maintain a structured audit log. The applied log in `groups/global/memory/self-improve/applied.md` is the only persistent record; observe it via `memory_search` or by reading the file.

If your investigation surfaces something that would benefit from a non-CLAUDE.md change (a new rule, a new memory file, a sender-allowlist tweak), include it as `*Also worth your attention:* …` inside the per-group proposal so the user can act manually. Don't try to apply it.
