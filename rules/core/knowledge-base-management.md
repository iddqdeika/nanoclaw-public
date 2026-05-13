# Knowledge Base Management

When accumulating factual knowledge about a project, system, or domain — store it in `/workspace/global/memory/{topic}/` as structured markdown files.

## Structure

Every knowledge base must have:
- `INDEX.md` — list of all files with one-line descriptions and key findings
- Topic files split by concern (architecture, people, data, operations, etc.)

## Trust Levels

Every fact must be marked with its trust level and date:

| Mark | Meaning |
|------|---------|
| `✅ апрув YYYY-MM-DD` | Confirmed by the user (or authoritative source like live code/DB) |
| `⚠️ неапрув` | From docs, Confluence, Jira, secondary sources — not yet verified |
| `❌ инвалид` | Explicitly disproved — keep the record, mark as invalid |

**Never present ⚠️ неапрув facts as confirmed.** Always signal uncertainty.

**Never delete ❌ инвалид entries** — keep them so future research doesn't repeat the mistake. Add a note explaining why it's invalid.

## Adding new facts

When the user confirms or corrects something:
1. Update the relevant file immediately
2. Change the mark to `✅ апрув YYYY-MM-DD`
3. If something was wrong, mark it `❌ инвалид` with an explanation

When facts come from research (code, DB, docs) without user confirmation:
- Mark as `⚠️ неапрув` until the user reviews
- Note the source (e.g., `⚠️ неапрув — из Confluence page 12345`)

## Good behavior ✓

- User says "feature X never worked" → immediately update the file, mark old entry `❌ инвалид`, add new `✅ апрув` fact
- Research finds something in code → write it as `⚠️ неапрув — из кода service-Y/module-Z, файл X` and ask user to confirm
- Answering a question about the system → read the file first, cite the trust level in the answer

## Bad behavior ✗

- Stating a ⚠️ неапрув fact without flagging uncertainty: "Service X uses Algorithm Y" (when it's only from secondary docs)
- Forgetting to update the file after user confirms something
- Deleting an invalidated fact instead of marking it ❌ инвалид
- Mixing facts from different trust levels in a single claim without distinguishing them
- Not maintaining INDEX.md when adding new files

## Research tasks

When scheduling research tasks to fill ⚠️ неапрув gaps:
- One question per task
- Task must write results back to the knowledge base file with appropriate trust mark
- Results presented to user for confirmation before upgrading to ✅ апрув

### Communication after a research task completes

After a research task reports its findings, always explicitly state whether you are blocked on user input before scheduling the next task.

**Do not just say "готово".** Always say what happens next and whether you need something.

Good: "Q4 результат получен, жду апрува перед тем как ставить Q6."
Bad: "Готово." (leaves user guessing whether next task is already scheduled or waiting)

If the next task in the queue requires the current result to be approved first — say so immediately when reporting completion. Do not wait for the user to ask.
