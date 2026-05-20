# OpenRouter Integration — Design & Phased Plan

**Status:** WIP draft, not implemented. Lives on branch `wip/openrouter`.
**Goals (from user):** cost reduction, unified billing/logging, model diversity (specifically: try GLM via Z.AI / OpenRouter).
**Non-goals:** keeping Claude Code Fast mode, Skills (Claude Code), or Anthropic Computer Use working when not on Anthropic 1P provider.
**Compatibility constraint:** must keep Anthropic-direct as an option, switchable via `.env`. No per-group / per-call routing yet.

## Current state — what we're changing

NanoClaw today:

```
Container agent-runner ─ stdio ──▶ Claude Agent SDK ──HTTP──▶ host:3011 ──HTTP──▶ api.anthropic.com
                                  (ANTHROPIC_BASE_URL)        (credential-proxy.ts,         (real API)
                                                               injects x-api-key from OneCLI)
```

Hard-coded assumptions in the current stack:

1. **`src/credential-proxy.ts`** forwards to whatever `secrets.ANTHROPIC_BASE_URL` says, defaults to `https://api.anthropic.com`. Auth header today: `x-api-key` (Anthropic-native).
2. **OneCLI secret type**: `anthropic`, host pattern `api.anthropic.com`. Single backend per install.
3. **Container env**: `ANTHROPIC_BASE_URL=http://host.docker.internal:3011`, `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (SDK needs a non-empty token even though the proxy ignores it).
4. **`@anthropic-ai/claude-agent-sdk` `query()`** drives the entire agent loop: streaming, tool use, MCP integration, sub-agent spawning, hooks, prompt caching. We don't have a parallel non-SDK path.
5. **`NANOCLAW_MODEL_PRIORITY`** is a comma-separated list of bare model names (`claude-haiku-4-5,claude-opus-4-7`). Used by the fallback chain in `getFallbackChain()`. The SDK takes the model name verbatim.
6. **`src/error-classifier.ts`** keys on Anthropic-shape error payloads (`{"type":"rate_limit_error",...}`, 401 with `invalid_grant`, etc.). The recovery system depends on this classification.

## Target state

```
Container agent-runner ─ stdio ──▶ Claude Agent SDK ──HTTP──▶ host:3011 ──HTTP──▶ {api.anthropic.com OR openrouter.ai/api}
                                  (ANTHROPIC_BASE_URL)        (credential-proxy.ts,         (selected at startup
                                                               backend-aware: x-api-key      via LLM_BACKEND env)
                                                               vs Authorization: Bearer)
```

What changes:

- A new `LLM_BACKEND` env var (`anthropic` | `openrouter`) selects the proxy upstream and auth scheme. Default `anthropic` so existing installs are untouched.
- Credential proxy gains backend awareness: looks up the right secret type, swaps auth header format.
- OneCLI gains an `openrouter` secret type (or we reuse a generic).
- Model name in `NANOCLAW_MODEL_PRIORITY` carries provider prefix when backend is OpenRouter: `anthropic/claude-sonnet-4.5`, `z-ai/glm-4.6`.
- Error classifier learns OR error shapes (especially for non-Claude upstreams).
- A small setup skill walks the user through choosing a backend, registering the secret, and validating.

What stays the same:

- Claude Agent SDK is unchanged. We're relying on OR's "Anthropic Skin" — it exposes the Anthropic Messages API natively. The SDK doesn't know it's not talking to Anthropic.
- Container layout, IPC, MCP gateway, memory, recovery — all unchanged.
- For Anthropic-direct mode, nothing changes (the new code paths are gated by `LLM_BACKEND`).

## Key reference: OpenRouter's Anthropic compatibility

Sources:

- [Claude Code Integration cookbook](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) — the canonical setup
- [Anthropic Models on OpenRouter](https://openrouter.ai/anthropic) — model list
- [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart) — generic auth/URL

Key facts for our use case:

- **Base URL**: `https://openrouter.ai/api` (SDK appends `/v1/messages`)
- **Auth**: `Authorization: Bearer $OPENROUTER_API_KEY` (Anthropic-native `x-api-key` does **not** work)
- **Anthropic-shaped requests**: tool_use, prompt-cache headers, thinking blocks pass through OR's "Anthropic Skin" unchanged — Claude Agent SDK semantics survive
- **Model IDs**: OR slugs (`~anthropic/claude-opus-latest`, `anthropic/claude-sonnet-4.5`, `z-ai/glm-4.6`, …)
- **Caveat**: Anthropic Skin is **optimized for Anthropic first-party provider**. Non-Anthropic models (GLM, Bedrock, Vertex) routed through it may have feature shape mismatches. Validation needed per-model.
- **Fast mode**: only Anthropic 1P. Lost when going through OR routing other providers. User said: not critical.

## Phase plan

Each phase is a discrete commit on `wip/openrouter`. Stop after each phase to gate go/no-go.

### Phase 0 — Read-only POC (no code change)

**Goal:** confirm OR's Anthropic Skin actually delivers what the SDK needs, both for Claude and for GLM.

Steps:

1. Buy/top-up OpenRouter credit (~$5 enough). Get an API key.
2. Manual curl against `https://openrouter.ai/api/v1/messages` with:
   - `~anthropic/claude-sonnet-latest` — text generation, then tool_use, then prompt_cache headers
   - `z-ai/glm-4.6` (or current GLM) — same battery
   - Streaming sanity check (SSE shape matches Anthropic's)
3. Document what worked, what fell back, what errored in `docs/OPENROUTER-INTEGRATION-PLAN.md` under "Phase 0 findings".

Deliverable: a one-page "compat matrix" — for each model, which features survive (basic text, tools, streaming, prompt cache, thinking, vision). Decides scope of Phase 4.

### Phase 1 — Backend-aware credential proxy

**Goal:** be able to flip the proxy to OpenRouter via `.env` without touching anything else, single-backend at a time.

Code changes:

- `src/credential-proxy.ts`:
  - New env `LLM_BACKEND` (default `anthropic`).
  - Backend config table (in code, small): upstream URL, auth header name (`x-api-key` vs `Authorization`), auth value format (`<key>` vs `Bearer <key>`), required OneCLI secret type.
  - `headers` injection branches on backend.
- `.env.example`: document `LLM_BACKEND` + `OPENROUTER_API_KEY` (if we go .env path) **or**
- OneCLI: register an `openrouter` secret type. Decision: probably reuse a generic `bearer` slot to avoid OneCLI fork friction. Detail TBD in Phase 1.

Tests: existing `credential-proxy.test.ts` extended with OR-mode case.

Setup-side: extend `init-onecli` skill (or write a new `switch-llm-backend` skill) to walk through the secret swap.

**Done when:** `LLM_BACKEND=openrouter` + valid OR key → existing telegram_main conversation works, agent uses Claude via OR, no code changes elsewhere.

### Phase 2 — Model selection layer

**Goal:** `NANOCLAW_MODEL_PRIORITY` works for both backends with appropriate naming.

Code changes:

- `src/container-runner.ts` / `container/agent-runner/src/index.ts`: model name passed verbatim; OR-formatted names already work because the SDK forwards them.
- `src/model-exhaustion.ts` (`getFallbackChain`): make sure fallback logic doesn't assume Anthropic-bare names.
- Optional: translation map for ergonomics (`claude-sonnet-4-5` → `anthropic/claude-sonnet-4.5`) when backend is OpenRouter. Probably skip — explicit is fine for a personal install.

Container config: extend per-group `containerConfig` with optional `modelPriority` override that already exists. Just document the OR naming.

**Done when:** `NANOCLAW_MODEL_PRIORITY=anthropic/claude-sonnet-4.5,z-ai/glm-4.6` works end-to-end: fallback chain hits each, rate-limit on one triggers the next.

### Phase 3 — Error classifier audit

**Goal:** the recovery system classifies OR errors correctly (so retries / give-up work).

Code changes:

- `src/error-classifier.ts`: review regex/string patterns. Add OR shapes:
  - OR-level 4xx (quota, model unavailable) — different from Anthropic's
  - Upstream provider errors (especially for non-Anthropic models — GLM returns its own error format that OR may pass through or wrap)
  - Streaming errors mid-response

Tests: extend `error-classifier.test.ts` with sample OR error payloads.

**Done when:** simulate_failure for each error_type still classifies correctly under OR backend, recovery decisions look sane.

### Phase 4 — GLM (or other non-Anthropic) validation

**Goal:** prove or disprove that GLM through OR's Anthropic Skin is usable for NanoClaw's agent loop.

Tests with `z-ai/glm-4.6`:

- Simple Q&A
- Tool use (Bash, Read)
- Multi-turn conversation
- MCP tool call (composio, if Phase 0 confirmed it works for any model)
- Session resume

Outcomes:

- ✅ Works well → document GLM as a supported alternative in setup skill
- ⚠️ Partial → list known broken features; mark GLM as "use for X, not Y"
- ❌ Broken → document why; potentially open Phase 4b for a parallel non-SDK code path (large scope — punt unless explicitly wanted)

**Done when:** compat matrix updated, GLM either green-lit or punted with clear notes.

### Phase 5 — Cost tracking (optional)

**Goal:** surface per-turn cost to the existing `turn_metrics` so users can compare backends.

OR returns a `generation_id` in response; cost is fetched via `GET /api/v1/generation?id=<id>`. Either:

- Background lookup after each turn, write to `turn_metrics.cost_usd`
- Or just rely on OR dashboard for the first iteration (skip code change)

Decision: probably skip for v1, OR dashboard is enough.

### Phase 6 — Docs & UX

- Setup skill: `setup-llm-backend` (or extend existing) with three flows: Anthropic-direct, OpenRouter, switching between.
- Update `setup-embeddings`-style operator doc for the new env vars.
- README: short mention with a link to the setup skill.
- `.env.example`: new vars.

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Anthropic Skin breaks subtly for tool_use under non-Claude models | Phase 0 POC catches it before Phase 1 |
| Prompt caching only works for Anthropic 1P → cost savings smaller than expected | Document in setup skill; can add provider-routing rules in OR dashboard later |
| `CLAUDE_CODE_OAUTH_TOKEN=placeholder` env causes SDK to misbehave when not on Anthropic | Test in Phase 1; may need to be empty string instead, mirroring Claude Code's own pattern |
| Skills (Claude Code) tool stops working through OR | User said non-critical; document as a known loss |
| OneCLI doesn't support arbitrary secret types | Reuse a generic slot; detail in Phase 1 |
| GLM through Anthropic Skin returns subtly malformed responses (e.g. tool_use IDs not matching, ordering wrong) | Phase 4 explicitly tests; fall back to "Anthropic-only via OR" if too broken |

## Out of scope (deliberate)

- Per-group / per-call backend routing (e.g. main on Claude, oneshot on GLM). Keep single global backend for v1.
- Parallel non-SDK path for OpenAI-compat models that don't fit Anthropic Skin. If Phase 4 says we need it, separate proposal.
- Cost-aware automatic model selection (cheapest model that meets task).
- Replacing the credential proxy with OneCLI gateway for LLM calls.

## Phase 0 findings (2026-05-20)

Target model: `z-ai/glm-4.6v` (user-selected). Endpoint: `https://openrouter.ai/api/v1/messages` (Anthropic Skin). Header set: `Authorization: Bearer <OR_KEY>`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`. All four tests against GLM, no Claude reference run (Anthropic 1P via OR is trivially equivalent to Anthropic-direct).

| Test | Outcome | Notes |
|---|---|---|
| A — plain text generation | ✅ | Response shape is fully Anthropic-native: `{type:"message", role:"assistant", content:[...], stop_reason, usage}`. GLM additionally emits a `type:"thinking"` block even without explicit thinking config — extended-thinking semantics pass through. |
| B — tool use | ✅ | `content` includes `{type:"tool_use", id, name, input}` blocks in Anthropic shape. Tool `id` format is OpenAI-flavored (`call_xxx…`) rather than Anthropic's `toolu_xxx`, but the SDK treats it as opaque so this is harmless. Also got `redacted_thinking` blocks alongside — OR's Anthropic Skin handles them. |
| C — streaming (SSE) | ✅ | Native Anthropic event sequence: `message_start` → `content_block_start` → `content_block_delta` (with `delta.type === "thinking_delta"` for thinking, `text_delta` for text) → `content_block_stop` → `message_stop`. Provider tag in `message_start`: `"provider":"Z.AI"`. SDK should parse identically to Anthropic-1P. |
| D — prompt caching | ⚠️ partial | `cache_control:{type:"ephemeral"}` on a `system` block is accepted (no error). Response `usage.cache_read_input_tokens: 4`, but `cache_creation_input_tokens: null`. So the hint is honored on the wire but the actual savings shape is GLM-provider-specific. Bonus: OR returns inline `cost: 0.0002696` per request — enables Phase 5 cost-tracking without an extra `GET /generation` round trip. |

**Verdict:** Phase 1 is safe to start. GLM 4.6v through Anthropic Skin produces SDK-compatible responses across text, tools, streaming, and prompt-cache hints. No parallel non-SDK path needed for the cases tested. Edge cases (multi-turn tool_use with continuations, MCP integration through container, session resume) still need Phase 4 to confirm at agent-loop level — Phase 0 only covered raw API shape.

**Known unknowns to verify in later phases:**

- GLM thinking emission is unprompted and verbose — may need to suppress for cost (Phase 4).
- `cache_creation_input_tokens: null` means we can't currently distinguish first-write vs cache-hit for cost analytics. Acceptable for v1.
- Z.AI provider tag in responses — should we surface to logging? (Probably yes, for the multi-provider story.)

**OR-side knobs spotted that we should expose in Phase 6:**

- Provider routing preferences (e.g. "Anthropic 1P only" guard) configurable per-request via `provider` field — not used in Phase 0 but documented in [OR provider routing](https://openrouter.ai/docs/features/provider-routing).
- BYOK for some providers — out of scope but worth noting in skill.

## Decision log

- 2026-05-20 — Plan drafted, branch `wip/openrouter` created.
- 2026-05-20 — Phase 0 POC run against `z-ai/glm-4.6v`. All four tests pass on the Anthropic Skin. Greenlight Phase 1.

## Secret storage decision (Option A, refined)

User chose Option A (separate OneCLI-managed secret for OR). OneCLI's `--type` is closed: only `anthropic` and `generic` accepted. Custom type would require an OneCLI patch we don't want.

Workable equivalent: use the existing `generic` type with explicit injection config — host-pattern, header name, and value format are all OR-specific, so the secret lives separately from the `anthropic` slot and gets injected correctly when traffic hits `openrouter.ai`.

```bash
onecli secrets create \
  --name OpenRouter \
  --type generic \
  --value <sk-or-v1-…> \
  --host-pattern openrouter.ai \
  --header-name Authorization \
  --value-format "Bearer {value}"
```

Verified on this install (id `c6fc2070-41cc-4997-b166-3b7e1921a95f`). `injectionConfig` saves correctly; the only quirk is that the create-response doesn't echo the injection block back (a `secrets list` shows it). Document this in the eventual setup skill.

Implication for the credential proxy: **no proxy-side auth swap needed**. OneCLI gateway already injects the right header for the right host based on the secret's `injectionConfig`. Our proxy just needs to forward to `openrouter.ai/api` when `LLM_BACKEND=openrouter`, and OneCLI does the auth header transformation. Simpler than originally planned.

## Phase 1 (refined) — upstream switch only

Updated scope given the OneCLI discovery:

- `src/credential-proxy.ts`: read `LLM_BACKEND` env (default `anthropic`). When `openrouter`, change the upstream from `https://api.anthropic.com` to `https://openrouter.ai/api`. No header logic change — OneCLI handles auth based on the resolved secret's host-pattern.
- `.env.example`: document `LLM_BACKEND`. Document the OneCLI command above.
- Test: extend `credential-proxy.test.ts` with a `LLM_BACKEND=openrouter` case that asserts the upstream URL flips.

That's it. Phases 2-6 unchanged.

## Decision log

- 2026-05-20 — Plan drafted, branch `wip/openrouter` created.
- 2026-05-20 — Phase 0 POC run against `z-ai/glm-4.6v`. All four tests pass on the Anthropic Skin. Greenlight Phase 1.
- 2026-05-20 — Secret storage: Option A via OneCLI `generic` type. No custom OneCLI type needed. Proxy-side auth swap not needed.

## Next action

Phase 1 implementation — small CR (one file + test + .env.example update). Awaiting greenlight to write code on this branch.
