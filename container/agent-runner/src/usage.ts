/**
 * Per-turn usage accumulation with per-message-id dedupe.
 *
 * The Anthropic SDK can emit multiple `assistant` events with the SAME
 * `message.id` for one streaming response — typically a thinking-phase event
 * followed by a final-text event. Both events carry a `usage.output_tokens`
 * field, but the field is NOT additive across the two: the second event's
 * value is the cumulative total for the message, and the first event is a
 * partial. Naively summing produces nonsense (we observed `output_tokens=14`
 * for responses whose JSONL transcript shows `output_tokens=1475`).
 *
 * This module exposes `accumulateMessageUsage`, which tracks the highest
 * `output_tokens` seen per message-id and only adds the *delta* to the turn
 * total. Whether the SDK emits cumulative values (7 → 1475) or repeats the
 * same partial twice (7 → 7), the resulting turn total is correct: it
 * equals the highest cumulative value across both events.
 *
 * Cache and input token fields are constant per API call (not streamed), so
 * we deduplicate them too — adding the values from the FIRST event seen for
 * each message-id and ignoring repeats. The SDK has been observed to emit
 * those fields identically on both events of the same message, so summing
 * would double-count.
 */

export interface TurnUsage {
  model: string | null;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  tool_call_count: number;
  tool_calls: Record<string, number>;
  max_context_tokens: number;
  sum_context_tokens: number;
  api_call_count: number;
}

export function emptyUsage(): TurnUsage {
  return {
    model: null,
    input_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    tool_call_count: 0,
    tool_calls: {},
    max_context_tokens: 0,
    sum_context_tokens: 0,
    api_call_count: 0,
  };
}

export interface AssistantUsageInput {
  /** Anthropic message id (`message.id` on the SDK assistant event).
   *  When undefined, dedupe falls back to summing every event — same
   *  behaviour as before the fix. */
  messageId?: string;
  model?: string;
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** Names of any `tool_use` content blocks on this assistant event. */
  toolUseNames?: string[];
}

/**
 * Per-turn dedupe state. Caller creates one of these alongside `turnUsage`,
 * resets it on every turn boundary (same lifecycle as `turnUsage`).
 */
export interface DedupeState {
  /** Highest output_tokens seen per message id. */
  outputByMessage: Map<string, number>;
  /** Set of message ids whose constant fields (input/cache) we've already
   *  counted, so a second emission of the same message doesn't double-count. */
  countedMessages: Set<string>;
}

export function emptyDedupe(): DedupeState {
  return {
    outputByMessage: new Map(),
    countedMessages: new Set(),
  };
}

/**
 * Apply one assistant event's usage to the running turn totals.
 * Mutates `usage` and `dedupe` in place. Tool-use counts always increment
 * (we never see the same tool_use block emitted twice across deduped events
 * — those live in the content array which is tied to the final emission).
 */
export function accumulateMessageUsage(
  usage: TurnUsage,
  dedupe: DedupeState,
  evt: AssistantUsageInput,
): void {
  if (evt.model) usage.model = evt.model;

  const callInput = evt.input_tokens ?? 0;
  const callCacheCreate = evt.cache_creation_input_tokens ?? 0;
  const callCacheRead = evt.cache_read_input_tokens ?? 0;
  const callOutput = evt.output_tokens ?? 0;
  const callContext = callInput + callCacheCreate + callCacheRead;

  // Output: take the MAX seen per message id, add only the new delta.
  if (evt.messageId) {
    const seen = dedupe.outputByMessage.get(evt.messageId) ?? 0;
    if (callOutput > seen) {
      usage.output_tokens += callOutput - seen;
      dedupe.outputByMessage.set(evt.messageId, callOutput);
    }
    // Constant fields (input/cache): count them only on the FIRST emission
    // of each message id. The SDK has been observed to repeat the same
    // values on the second emission of the same message; summing
    // double-counts cache_creation, which we then over-attribute to spend.
    if (!dedupe.countedMessages.has(evt.messageId)) {
      dedupe.countedMessages.add(evt.messageId);
      usage.input_tokens += callInput;
      usage.cache_creation_tokens += callCacheCreate;
      usage.cache_read_tokens += callCacheRead;
      if (callContext > 0) {
        if (callContext > usage.max_context_tokens) {
          usage.max_context_tokens = callContext;
        }
        usage.sum_context_tokens += callContext;
        usage.api_call_count++;
      }
    }
  } else {
    // No message id — fall back to additive (legacy path).
    usage.input_tokens += callInput;
    usage.cache_creation_tokens += callCacheCreate;
    usage.cache_read_tokens += callCacheRead;
    usage.output_tokens += callOutput;
    if (callContext > 0) {
      if (callContext > usage.max_context_tokens) {
        usage.max_context_tokens = callContext;
      }
      usage.sum_context_tokens += callContext;
      usage.api_call_count++;
    }
  }

  for (const name of evt.toolUseNames ?? []) {
    usage.tool_call_count++;
    usage.tool_calls[name] = (usage.tool_calls[name] ?? 0) + 1;
  }
}
