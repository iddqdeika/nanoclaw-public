---
name: setup-embeddings
description: Configure the host-side embedding endpoint that powers NanoClaw's memory indexer and recall block. Use when memory isn't surfacing in recall, when switching from default LM Studio to Ollama / OpenAI / another OpenAI-compatible provider, or when documenting embedding setup for a new install.
---

# Setting up the embedding endpoint

NanoClaw's per-group + global memory pipeline (`src/memory/`) needs an OpenAI-compatible `/v1/embeddings` endpoint:

- **Indexer** (runs on every NanoClaw startup) embeds new/changed markdown files in `groups/{folder}/memory/`, `groups/{folder}/wiki/`, `groups/{folder}/CLAUDE.md`, and `groups/global/memory/`. Vectors land in `data/memory/{folder}/chunks.lance`.
- **Prefill** (runs before each agent turn) embeds the latest user message, top-k vector-searches the index, and injects matches into the system prompt as a `<recall>` block.

If the endpoint is unreachable, the indexer logs warnings + skips files, and prefill catches the throw and falls back to an **empty `<recall>` block**. The agent still answers — just with no memory context. There is **no automatic provider fallback**: whatever URL is in `.env` is the one used.

## Configuration

All read by `src/memory/embed.ts` at process start. Set in `.env` at the project root.

| Variable | Default | Notes |
|---|---|---|
| `EMBEDDING_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible `/v1/embeddings` base (no trailing `/embeddings`) |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5@q8_0` | Must match what the endpoint actually serves |
| `EMBEDDING_DIM` | `768` | Output dim. If the endpoint returns more, Matryoshka-truncated (slice + L2 normalize). Cannot expand a smaller native dim. |
| `EMBEDDING_API_KEY` | empty | Sent as `Authorization: Bearer …` if set; not needed for local endpoints |

## Supported setups (pick one)

### LM Studio — default

Local app, GUI for model management. Defaults above work out of the box once you load `text-embedding-nomic-embed-text-v1.5@q8_0` and start the local server on port 1234. Free.

Verify:
```bash
curl -s http://127.0.0.1:1234/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"text-embedding-nomic-embed-text-v1.5@q8_0","input":"test"}' \
  | head -c 200
```

### Ollama — recommended free fallback

Fully local, CLI-driven, smaller footprint than LM Studio. Free, ~300 MB on disk.

```bash
ollama serve                 # daemon (typically already running)
ollama pull nomic-embed-text
```

`.env`:
```
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIM=768
```

### OpenAI — paid hosted

Fast, no local infrastructure. Pricing as of mid-2026: ~$0.02 per 1M input tokens for `text-embedding-3-small`.

`.env`:
```
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
EMBEDDING_API_KEY=sk-...
```

### Any other OpenAI-compatible provider

Voyage AI, Together AI, vLLM with an embed model, llama.cpp server, etc. — all work if they expose `/v1/embeddings`. Set `EMBEDDING_BASE_URL` + `EMBEDDING_MODEL` accordingly; `EMBEDDING_API_KEY` if the provider needs auth.

## Applying changes

`.env` is read once at process start.

1. Edit `.env`.
2. Restart NanoClaw (`pm2 restart nanoclaw` or your platform's equivalent — see [`windows-ops`](../windows-ops/SKILL.md) for restart safety).
3. Watch `data/nanoclaw.log` for the first `indexer: reindexGroup complete` line — `chunksUpserted` > 0 on first run for a new model means embeds worked. `errors > 0` means the endpoint refused something; check log for the URL + status code.

## Cache and re-embedding

Embeddings are deduplicated in `store/embedding_cache.db` by `(model, dim, text)` hash. Consequences:

- Same file content + same model → no re-call to the endpoint, even across restarts.
- A momentarily-offline endpoint **doesn't lose existing recall**; only new writes / edits will fail to index until it's back.
- **Switching models** (`EMBEDDING_MODEL` change) invalidates the cache for that model and re-embeds everything on next indexer pass. Cache rows for the old model remain (cheap, takes a few MB) — wipe them with `rm store/embedding_cache.db` for a truly clean slate.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `<recall>` block always empty | Endpoint unreachable | `curl` the URL from the box NanoClaw runs on; check log for `Embeddings API <status>: …` warns |
| `chunksUpserted: 0` on every reindex | Files unchanged (mtime cache hit) — normal | Verify by editing one file → next reindex should show chunks |
| `errors > 0` in indexer logs | Endpoint returned 4xx/5xx | Log shows the URL + status; check model name matches what server serves |
| Recall returns results but they look truncated/garbled | `EMBEDDING_DIM` larger than what the server outputs | Lower `EMBEDDING_DIM` or switch model |
| Switched provider, recall still shows old hits | Cache rows for old model still served by indexer | Wipe `store/embedding_cache.db` and `data/memory/` + restart for a full re-embed |

## What this skill does NOT cover

- Writing memory content (that's [`rules/core/group-memory.md`](../../../rules/core/group-memory.md) — agent behavior, not infra).
- Per-tier filtering rules (also in the group-memory rule).
- Adding new memory sources (path globs, scopes) — edit `src/memory/sources.ts` directly; the structure is documented in that file's top comment.
