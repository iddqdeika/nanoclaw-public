/**
 * Integration test for one-shot agents.
 * Spawns a real container with a simple task, verifies it can
 * read/write the parent group folder.
 *
 * Usage: npx tsx scripts/test-oneshot.ts
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, ASSISTANT_NAME } from '../src/config.js';
import {
  buildOneshotMounts,
  runContainerAgent,
} from '../src/container-runner.js';
import { loadRules } from '../src/rules-loader.js';
import { startCredentialProxy } from '../src/credential-proxy.js';
import {
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from '../src/container-runtime.js';
import { CREDENTIAL_PROXY_PORT } from '../src/config.js';
import { RegisteredGroup } from '../src/types.js';

const TEST_PARENT_DIR = path.join(GROUPS_DIR, 'test-oneshot-parent');
const TASK_FILE = path.join(TEST_PARENT_DIR, 'task.md');
const RESULT_FILE = path.join(TEST_PARENT_DIR, 'result.txt');

async function main() {
  console.log('=== One-shot agent integration test ===\n');

  // 1. Setup
  console.log('1. Setting up test parent folder...');
  fs.mkdirSync(TEST_PARENT_DIR, { recursive: true });
  fs.writeFileSync(TASK_FILE, 'The capital of France is Paris.\n');

  if (fs.existsSync(RESULT_FILE)) fs.unlinkSync(RESULT_FILE);

  // 2. Ensure container runtime
  console.log('2. Checking container runtime...');
  ensureContainerRuntimeRunning();

  // 3. Start credential proxy
  console.log('3. Starting credential proxy...');
  const proxy = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // 4. Build mounts
  console.log('4. Building oneshot mounts (scope: core)...');
  const oneshotId = `test-${Date.now()}`;
  const oneshotDir = path.join(DATA_DIR, 'oneshot', oneshotId);
  fs.mkdirSync(oneshotDir, { recursive: true });

  const parentIpcDir = path.join(DATA_DIR, 'ipc', 'test-oneshot-parent');
  fs.mkdirSync(path.join(parentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(parentIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(parentIpcDir, 'input'), { recursive: true });

  const mounts = buildOneshotMounts({
    oneshotDir,
    parentGroupDir: TEST_PARENT_DIR,
    parentIpcDir,
    scope: 'core',
  });

  console.log(
    '   Mounts:',
    mounts.map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
  );

  // 5. Prepare prompt
  const rules = loadRules(false);
  const prompt = rules
    ? `<system_rules>\n${rules}\n</system_rules>\n\nRead /workspace/parent/task.md and write its content to /workspace/parent/result.txt. Do not add any other text.`
    : 'Read /workspace/parent/task.md and write its content to /workspace/parent/result.txt. Do not add any other text.';

  const group: RegisteredGroup = {
    name: `oneshot-${oneshotId}`,
    folder: `oneshot-${oneshotId}`,
    trigger: '',
    added_at: new Date().toISOString(),
    isMain: false,
  };

  // 6. Spawn container
  console.log('5. Spawning container...');
  const startTime = Date.now();

  const output = await runContainerAgent(
    group,
    {
      prompt,
      groupFolder: `oneshot-${oneshotId}`,
      chatJid: 'test@test',
      isMain: false,
      assistantName: ASSISTANT_NAME,
    },
    (proc, containerName) => {
      console.log(`   Container: ${containerName} (PID: ${proc.pid})`);
    },
    async (result) => {
      if (result.result) {
        const text = result.result
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (text) console.log(`   Agent output: ${text.slice(0, 100)}...`);
      }
    },
    mounts,
  );

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`   Status: ${output.status} (${duration}s)`);

  // 7. Verify
  console.log('\n6. Verifying results...');
  const resultExists = fs.existsSync(RESULT_FILE);
  console.log(`   result.txt exists: ${resultExists}`);

  if (resultExists) {
    const content = fs.readFileSync(RESULT_FILE, 'utf-8').trim();
    console.log(`   result.txt content: "${content}"`);
    const pass = content.includes('Paris');
    console.log(`   Test: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  } else {
    console.log('   Test: FAIL ✗ (result.txt not created)');
  }

  // 8. Cleanup
  console.log('\n7. Cleaning up...');
  fs.rmSync(TEST_PARENT_DIR, { recursive: true, force: true });
  fs.rmSync(oneshotDir, { recursive: true, force: true });
  const sessionsDir = path.join(DATA_DIR, 'sessions', `oneshot-${oneshotId}`);
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  fs.rmSync(parentIpcDir, { recursive: true, force: true });

  proxy.close();
  console.log('   Done.\n');
  process.exit(resultExists ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
