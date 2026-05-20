// Minimal SDK-direct call to OR. Goal: catch the full stack of
// "Cannot read properties of undefined (reading 'input_tokens')" so we
// know whether it's SDK-internal or in our agent-runner glue.
//
// Run inside the container:
//   docker run --rm -i --network=host \
//     -e ANTHROPIC_BASE_URL=http://host.docker.internal:3011 \
//     -e ANTHROPIC_API_KEY=placeholder \
//     -v "$PWD/scripts/sdk-or-isolated.mjs:/tmp/test.mjs" \
//     --entrypoint node nanoclaw-agent:latest /tmp/test.mjs

import { query } from '@anthropic-ai/claude-agent-sdk';

process.on('unhandledRejection', (e) => {
  process.stderr.write(`UNHANDLED: ${e?.stack || e}\n`);
});
process.on('uncaughtException', (e) => {
  process.stderr.write(`UNCAUGHT: ${e?.stack || e}\n`);
});

try {
  let count = 0;
  for await (const msg of query({
    prompt: 'Say "ok" in one word.',
    options: {
      allowedTools: ['Bash'],
      permissionMode: 'bypassPermissions',
    },
  })) {
    count++;
    process.stderr.write(
      `[evt #${count}] type=${msg.type} subtype=${msg.subtype || '-'}\n`,
    );
    if (msg.type === 'result') {
      process.stderr.write(
        `  result.result=${JSON.stringify(msg.result || msg).slice(0, 400)}\n`,
      );
    }
  }
  process.stderr.write('=== loop ended normally ===\n');
} catch (err) {
  process.stderr.write(`THROW: ${err?.stack || err}\n`);
}
