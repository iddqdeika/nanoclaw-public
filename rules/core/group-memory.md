# Group Memory — Capture What the User Tells You

Per-group long-term memory lives at `/workspace/group/memory/`. The indexer scans it on every startup, embeds each markdown file via the local embedding endpoint, and the prefill step injects a semantically-relevant `<recall>` block into every turn's prompt — so the next conversation in **this group** can pick up where the last one ended without re-asking.

## The rule

Whenever the user supplies a new fact that's likely to matter again, write it to the appropriate file under `/workspace/group/memory/`. Whenever the user asks you to recall something, **trust the `<recall>` block first** — if it doesn't answer the question, `Read` the file directly before answering from session memory.

## Two scopes, one trust model

| Path | Scope | When to use |
|---|---|---|
| `/workspace/group/memory/*.md` | **this group only** | The default. Per-chat people, cases, preferences, synonyms. Other groups never see these. |
| `/workspace/global/memory/*.md` | **all groups** | Only for things that should be true *everywhere*: validated cross-cutting facts, big shared projects, organization-wide vocabulary. Anything you write here will surface in every other chat's recall. |

Both are indexed and surfaced via `<recall>`. Both are filtered by trust tier — `untrusted` agents get an **empty** recall block (zero memory leakage); `main` and `trusted` see results from their tier-allowed scopes.

Default to **group memory**. Only escalate to global when the fact genuinely matters outside this chat AND has been validated.

## Where to write (per-group layout)

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
| Project status or scope the user just stated | Project trivia derivable from the code |
| A problem the user reported AND its resolution | Open problems with no resolution yet — those go in `tasks.md` |
| A preference the user states or repeats ("always use metric units") | Inferred preferences (you'd just be guessing) |
| Synonyms / aliases the user introduces | Standard terminology |

## How to mark trust

Same trust marks as [`knowledge-base-management.md`](knowledge-base-management.md):

| Mark | Meaning |
|------|---------|
| `✅ апрув YYYY-MM-DD` | User stated it directly, or you wrote it down and the user later confirmed |
| `⚠️ неапрув` | You inferred it, you partially heard it, or context was incomplete — likely correct but not verified |
| `❌ инвалид` | Disproved later — keep the entry, never delete; future reads see the correction |

Default new entries to `⚠️ неапрув` unless the user said the thing in unambiguous, complete words during this turn. Promote to `✅ апрув YYYY-MM-DD` after the user accepts your phrasing back to them.

**Escalation to global memory** requires `✅ апрув` first. Never copy `⚠️ неапрув` group facts into global — global is the validated layer.

## How recall works (so you can trust what you see)

The prefill step (host-side, `src/memory/prefill.ts`) builds a `<recall>` block from the latest user message:

1. Embed the user text via an OpenAI-compatible `/v1/embeddings` endpoint.
2. Vector-search the index store (`data/memory/{group}/chunks.lance`) for top-k matches across the tier's allowed scopes.
3. Filter by **tier**: `untrusted` → empty block; `main`/`trusted` → group + global hits.
4. Inject the matched chunks into the system prompt before your first turn.

The indexer only re-embeds files when their mtime changes (cache: `store/embedding_cache.db`). Edit → save → it's in the next recall after the next reindex tick.

### Embedding endpoint configuration

Configured via env vars in `.env` (read by `src/memory/embed.ts`):

| Variable | Default | Notes |
|---|---|---|
| `EMBEDDING_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible `/v1/embeddings` base |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5@q8_0` | Must match what the endpoint serves |
| `EMBEDDING_DIM` | `768` | Output dim. Matryoshka-truncated (truncate + L2 normalize) if model emits larger |
| `EMBEDDING_API_KEY` | empty | Sent as `Authorization: Bearer …` if set; not needed for local endpoints |

If the endpoint is unreachable, embeds throw. Indexer skips affected files (logs warn, increments `errors`). Prefill catches the throw and falls back to an **empty `<recall>` block** — you still answer, just without memory context. There is **no automatic provider fallback**: the URL in env is the one used.

Supported setups (all OpenAI-compatible, choose one):

- **LM Studio** (default) — local app, GUI for model management. Defaults above work out of the box once you load `text-embedding-nomic-embed-text-v1.5@q8_0`.
- **Ollama** — fully local, CLI-driven. Setup: `ollama serve` + `ollama pull nomic-embed-text`. In `.env`: `EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1`, `EMBEDDING_MODEL=nomic-embed-text`. Free, ~300 MB on disk.
- **OpenAI** (paid) — hosted, fast. In `.env`: `EMBEDDING_BASE_URL=https://api.openai.com/v1`, `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIM=1536`, `EMBEDDING_API_KEY=sk-…`. ~$0.02 per 1M input tokens at time of writing.
- **Voyage / Together / vLLM / llama.cpp / …** — any OpenAI-compatible `/v1/embeddings` endpoint works; set URL + model + (optional) API key accordingly.

Once a file is embedded, the vector lives in `store/embedding_cache.db` keyed by `(model, dim, text)` hash. Subsequent runs with the same model don't re-call the endpoint until the file content changes — so a momentarily-offline endpoint doesn't lose existing recall, only new writes.

## How to recall

If the user asks "напомни / что мы решили / кто такой / what did we do about X":

1. Look at the `<recall>` block — it's been built for this exact question. Often the answer is right there.
2. If recall is empty or doesn't cover it, `Read` the relevant file directly.
3. If the source is `⚠️ неапрув`, **flag the uncertainty**:

   > "По моим записям — Vasya отвечает за backend (⚠️ неапрув, fix from 2026-04-12). Подтвердишь?"

Never present `⚠️ неапрув` data as definitive. If the only record is `❌ инвалид`, surface that too — say what you used to think and why it was wrong.

## Why this matters

Long sessions get summarized; threads get truncated; you might be a fresh agent boot reading a session that someone else's compaction wrote. Anything that lived only in the visible message window will eventually disappear. The group-memory file is the durable layer for things specific to *this chat*.

But: memory is also where the model's worst habits compound. Without a trust mark, an `⚠️ неапрув` guess from three months ago looks identical to a fact the user dictated yesterday. The marks are how you stay honest.

## Good behavior ✓

- User: "we resolved the staging crash by rolling back to v2.1.4" → append a heading in `cases.md` with symptom, root cause, fix; mark `✅ апрув YYYY-MM-DD`
- User: "I think Vasya owns the deploy bot, but check with him" → write to `people.md` as `⚠️ неапрув — нужно подтвердить у Васи`
- User asks "what did we do about that staging crash" → check `<recall>` first; if needed, `Read cases.md`, cite the entry, include the trust mark
- User: "actually it was Petya, not Vasya" → flip the Vasya entry to `❌ инвалид (на YYYY-MM-DD: на самом деле Петя)`, add a new `✅ апрув` Petya entry
- User in chat-A: "the company-wide deploy bot is owned by Petya, confirmed across teams" → after `✅ апрув`, copy that entry into `/workspace/global/memory/people.md` so other chats see it too

## Bad behavior ✗

- Storing every passing remark — memory becomes noise; the recall block gets junk too
- Writing inferences as `✅ апрув` because they "feel obvious"
- Recalling from session memory when a memory file exists; the file is the source of truth
- Deleting an entry the user later corrected instead of marking `❌ инвалид` with the reason
- Stating a `⚠️ неапрув` fact in a reply without flagging the uncertainty
- Forgetting to update `INDEX.md` when adding a new topic file
- Writing chat-specific notes to `/workspace/global/memory/` — that leaks them to every other group
- Escalating `⚠️ неапрув` facts to global memory without explicit `✅ апрув` first

## Indexed locations summary

| Path | Scope | Indexed | Visible to (recall) |
|---|---|---|---|
| `/workspace/group/memory/**/*.md` | per-group | ✅ | main + trusted, **only the originating group** |
| `/workspace/group/wiki/**/*.md` | per-group | ✅ | main + trusted, only the originating group |
| `/workspace/group/CLAUDE.md` | per-group identity | ✅ | main + trusted, only the originating group |
| `/workspace/global/memory/*.md` | global, no domain | ✅ | main + trusted, any group |
| `/workspace/global/memory/<dir>/*.md` | global, domain = `<dir>` | ✅ | main + trusted, only when query matches the domain |

For domain-tagged knowledge bases (multiple files per topic), see [`knowledge-base-management.md`](knowledge-base-management.md). The trust-mark vocabulary is shared.
