# Group Memory — Capture What the User Tells You

Per-group long-term memory lives at `/workspace/group/memory/`. Use it to remember things specific to *this* chat: people, projects, ongoing tasks, resolved cases, preferences, vocabulary the user uses for things. The next conversation in this group should not have to re-learn what this one did.

## The rule

Whenever the user supplies a new fact that's likely to matter again, write it to the appropriate file in `/workspace/group/memory/`. Whenever the user asks you to recall something, **read those files first** before answering from session memory.

## Where to write

```
/workspace/group/memory/
  INDEX.md          — one-line description per file; keep current
  people.md         — names, roles, contact details, who-is-who
  projects.md       — project names, stakeholders, current state
  tasks.md          — open tasks, deadlines, who owns what (live state)
  cases.md          — resolved problems with the resolution; one heading per case
  preferences.md    — how the user wants things done (formatting, tone, defaults)
  synonyms.md       — user's vocabulary: "the dashboard" = grafana.internal/d/api;
                      "Vasya" = Василий Петров; etc.
```

Create files lazily — don't pre-create empty ones. Add new topic files as the chat earns them. `INDEX.md` always exists once any topic file does.

## What to capture

| Capture | Skip |
|---|---|
| Names mentioned with a role ("Vasya is the backend lead") | Random one-off mentions ("Vasya said hi") |
| Project status or scope user just stated | Project trivia derivable from the code |
| A problem the user reported AND its resolution | Open problems with no resolution yet — those go in `tasks.md` |
| A preference the user states or repeats ("always use metric units") | Inferred preferences (you'd just be guessing) |
| Synonyms / aliases the user introduces | Standard terminology |

## How to mark trust

Same trust marks as `knowledge-base-management.md`:

| Mark | Meaning |
|------|---------|
| `✅ апрув YYYY-MM-DD` | User stated it directly, or you wrote it down and the user later confirmed |
| `⚠️ неапрув` | You inferred it, you partially heard it, or context was incomplete — likely correct but not verified |
| `❌ инвалид` | Disproved later — keep the entry, never delete; future reads see the correction |

Default new entries to `⚠️ неапрув` unless the user said the thing in unambiguous, complete words during this turn. Promote to `✅ апрув YYYY-MM-DD` after the user accepts your phrasing back to them.

## How to recall

When the user says "напомни / что мы решили / кто такой / what did we do about" — `Read` the relevant file first, then answer. If the source is `⚠️ неапрув`, **flag the uncertainty in your reply**:

> "По моим записям — Vasya отвечает за backend (⚠️ неапрув, fix from 2026-04-12). Подтвердишь?"

Never present `⚠️ неапрув` data as definitive. If the only record is `❌ инвалид`, surface that too — say what you used to think and why it was wrong.

## Why this matters

Long sessions get summarized; threads get truncated; you might be a fresh agent boot reading a session that someone else's compaction wrote. Anything that lived only in the visible message window will eventually disappear. The group memory file is the durable layer.

But: memory is also where the model's worst habits compound. Without a trust mark, an `⚠️ неапрув` guess from three months ago looks identical to a fact the user dictated yesterday. The marks are how you stay honest.

## Good behavior ✓

- User: "we resolved the staging crash by rolling back to v2.1.4" → append a heading in `cases.md` with the symptom, root cause, and fix, marked `✅ апрув YYYY-MM-DD`
- User: "I think Vasya owns the deploy bot, but check with him" → write to `people.md` as `⚠️ неапрув — нужно подтвердить у Васи`
- User asks "what did we do about that staging crash" → `Read cases.md`, cite the entry, include the trust mark
- User: "actually it was Petya, not Vasya" → flip the Vasya entry to `❌ инвалид (на 2026-05-15: на самом деле Петя)`, add a new `✅ апрув` Petya entry

## Bad behavior ✗

- Storing every passing remark — memory file becomes noise
- Writing inferences as `✅ апрув` because they "feel obvious"
- Recalling from session memory when a memory file exists; the file is the source of truth
- Deleting an entry the user later corrected instead of marking `❌ инвалид` with the reason
- Stating a `⚠️ неапрув` fact in a reply without flagging the uncertainty
- Forgetting to update `INDEX.md` when adding a new topic file

## Scope

This rule covers per-group memory only. For cross-group facts about a project / system / domain, see [`knowledge-base-management.md`](knowledge-base-management.md) and write to `/workspace/global/memory/{topic}/` instead. The trust-mark vocabulary is shared.
