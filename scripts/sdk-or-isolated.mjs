// Progressive SDK test. Toggle features via env to bisect what
// breaks the agent loop under OR/Haiku.
//
// Run inside container:
//   docker run --rm -i \
//     -e ANTHROPIC_BASE_URL=http://host.docker.internal:3011 \
//     -e ANTHROPIC_API_KEY=placeholder \
//     -e ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-haiku-4.5 \
//     -e TEST_PRESET=bare              # or +system, +tools, +mcp, +settingSources
//     -v $PWD/scripts/sdk-or-isolated.mjs:/app/test.mjs:ro \
//     --workdir /app --entrypoint node nanoclaw-agent:latest test.mjs

import { query } from '@anthropic-ai/claude-agent-sdk';

const PRESET = process.env.TEST_PRESET || 'bare';

const opts = {
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash'],
};

if (PRESET.includes('system')) {
  opts.systemPrompt = {
    type: 'preset',
    preset: 'claude_code',
    append: 'You are helpful. Answer concisely.',
  };
}
if (PRESET.includes('tools')) {
  opts.allowedTools = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'Skill',
  ];
}
if (PRESET.includes('settingSources')) {
  opts.settingSources = ['project', 'user'];
}
if (PRESET.includes('dangerous')) {
  opts.allowDangerouslySkipPermissions = true;
}
if (PRESET.includes('nothink')) {
  // Try a few possible SDK config keys for disabling extended thinking
  opts.thinking = { type: 'disabled' };
}

process.stderr.write(`=== preset: ${PRESET} ===\n`);
process.stderr.write(`=== opts: ${JSON.stringify(opts).slice(0, 200)} ===\n`);

process.on('unhandledRejection', (e) => {
  process.stderr.write(`UNHANDLED: ${e?.stack || e}\n`);
});

try {
  let count = 0;
  for await (const msg of query({
    prompt: 'Say only "ok" in lowercase.',
    options: opts,
  })) {
    count++;
    process.stderr.write(
      `[evt #${count}] type=${msg.type} subtype=${msg.subtype || '-'}\n`,
    );
    if (msg.type === 'assistant') {
      const m = msg.message;
      const content = m?.content || [];
      process.stderr.write(
        `  raw_msg=${JSON.stringify(m).slice(0, 500)}\n`,
      );
    }
    if (msg.type === 'result') {
      process.stderr.write(
        `  result.result=${JSON.stringify(msg.result || '').slice(0, 200)}\n`,
      );
    }
  }
  process.stderr.write('=== loop ended normally ===\n');
} catch (err) {
  process.stderr.write(`THROW: ${err?.stack || err}\n`);
}
