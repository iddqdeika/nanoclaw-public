/**
 * Canonical reaction vocabulary. The orchestrator and the agent use these
 * meaning-based names. Each channel privately maps them to its own emoji or
 * shortcode. Platform specifics (Slack shortcodes, Telegram allowed-emoji set)
 * are invisible to callers.
 *
 * Adding a reaction here without covering it in every channel's map will fail
 * the TypeScript build — `Record<CanonicalReaction, string>` enforces
 * completeness. That's intentional: silent drops are worse than a build break.
 *
 * Keep `AGENT_CALLABLE_REACTIONS` in sync with the `z.enum` in the
 * agent-runner MCP tool (container/agent-runner/src/ipc-mcp-stdio.ts).
 */

export const CANONICAL_REACTIONS = [
  // Orchestrator lifecycle — fired automatically, not callable by the agent.
  'saw',
  'done',
  'cancel',
  // Agent-callable progress signals — the agent picks one of these via
  // set_progress_reaction on long turns.
  'working',
  'searching',
  'writing',
  'building',
  'thinking',
  'reading',
  'retrying',
] as const;

export type CanonicalReaction = (typeof CANONICAL_REACTIONS)[number];

export const AGENT_CALLABLE_REACTIONS = [
  'working',
  'searching',
  'writing',
  'building',
  'thinking',
  'reading',
  'retrying',
] as const satisfies readonly CanonicalReaction[];

export type AgentReaction = (typeof AGENT_CALLABLE_REACTIONS)[number];

export function isCanonicalReaction(v: unknown): v is CanonicalReaction {
  return (
    typeof v === 'string' &&
    (CANONICAL_REACTIONS as readonly string[]).includes(v)
  );
}

export const REACTION_DESCRIPTIONS: Record<CanonicalReaction, string> = {
  saw: 'Message received and turn starting',
  done: 'Turn completed successfully',
  cancel: 'Turn errored or was aborted',
  working: 'Actively working on the task (default proof-of-life signal)',
  searching: 'Researching or looking up information',
  writing: 'Composing output',
  building: 'Compiling or constructing',
  thinking: 'Deep reasoning',
  reading: 'Reading and absorbing content',
  retrying: 'Trying again after a failure',
};
