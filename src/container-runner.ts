/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MCP_GATEWAY_PORT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { getGatewayInstance } from './mcp-gateway/instance.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { getFallbackChain } from './model-exhaustion.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export type TrustLevel = 'main' | 'trusted' | 'untrusted';

export function getTrustLevel(group: RegisteredGroup): TrustLevel {
  if (group.isMain) return 'main';
  if (group.containerConfig?.trusted) return 'trusted';
  return 'untrusted';
}

const SKILL_TIERS: Record<TrustLevel, string[]> = {
  main: ['core', 'trusted', 'admin'],
  trusted: ['core', 'trusted'],
  untrusted: ['core', 'untrusted'],
};

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Active idle-timeout resetters keyed by group folder. Populated for the
// lifetime of each running container; the IPC watcher calls
// `bumpContainerActivity` from any successfully-processed IPC, which keeps
// the watchdog quiet for agents that are doing real work via tool calls
// (long Bash, slow SQL, MCP gateway round-trips) but emit no stdout token
// stream during that window. Without this, the 30-min idle reaper kills
// busy-but-silent agents.
const activeTimeoutResetters = new Map<string, () => void>();

/**
 * Reset the idle watchdog for the running container of the given group.
 * No-op if the group has no live container. Safe to call from any IPC
 * handler — keys by `group.folder` (e.g. "slack_main", "oneshot-<id>").
 */
export function bumpContainerActivity(groupFolder: string): void {
  const reset = activeTimeoutResetters.get(groupFolder);
  if (reset) reset();
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  threadId?: string;
}

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

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: TurnUsage;
  /** Container exit code (null if process didn't exit normally). */
  exitCode?: number | null;
  /** True if killed by the idle-timeout watchdog. */
  killedByTimeout?: boolean;
  /** Captured stderr from the container (truncated to CONTAINER_MAX_OUTPUT_SIZE). */
  stderr?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Recursive newest-mtime over a directory tree. Used to detect agent-runner-src
 * staleness — comparing only `index.ts` mtime missed updates to sibling files
 * like `gateway-client.ts` and produced stale shim caches per-group.
 */
function newestMtimeMs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cur);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else if (stat.isFile()) {
      if (stat.mtimeMs > max) max = stat.mtimeMs;
    }
  }
  return max;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const trustLevel = getTrustLevel(group);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory.
    // - main/trusted: writable. Trusted writes land as `status: unconfirmed`
    //   and are gated by the pending-confirmation flow handled by admin/is_main
    //   groups (see rules/admin/pending-confirmations.md).
    // - untrusted: NOT MOUNTED. Cross-group memory can contain sensitive
    //   info from other groups (confirmed admin records, brand-specific data,
    //   etc.). Untrusted groups can be compromised by prompt-injection from
    //   external users — they must not see what they could be tricked into
    //   exfiltrating. See rules/untrusted/global-memory-isolation.md.
    if (trustLevel !== 'untrusted') {
      const globalDir = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDir)) {
        mounts.push({
          hostPath: globalDir,
          containerPath: '/workspace/global',
          readonly: false,
        });
      }
    }

    // Shadow per-group mcp-secrets.json for trusted/untrusted groups using
    // the host-side MCP gateway. The gateway reads its master credentials
    // from groups/_gateway/mcp-secrets.json (see src/mcp-gateway/secrets.ts)
    // and mints per-group tokens — the agent never needs the raw secrets
    // visible inside its own container. Without this shadow, the agent
    // could `cat /workspace/group/mcp-secrets.json` and read plaintext
    // credentials it has no functional use for.
    //
    // Main groups intentionally keep the file visible — admin tier benefits
    // from being able to inspect / work around credential issues directly.
    const useGateway = group.containerConfig?.useMcpGateway === true;
    const groupSecretsFile = path.join(groupDir, 'mcp-secrets.json');
    if (useGateway && fs.existsSync(groupSecretsFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/group/mcp-secrets.json',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from skills/{tier}/ into each group's .claude/skills/
  // Only tiers matching the group's trust level are copied
  const skillsSrc = path.join(process.cwd(), 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const tier of SKILL_TIERS[trustLevel]) {
      const tierSrc = path.join(skillsSrc, tier);
      if (!fs.existsSync(tierSrc)) continue;
      for (const skillDir of fs.readdirSync(tierSrc)) {
        const srcDir = path.join(tierSrc, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
      }
    }
  }

  // Sync NanoClaw-managed personas from project-root personas/*.md into
  // each group's session .claude/agents/ (SDK-standard discovery path).
  // The lead spawns a typed sub-agent via `Task(subagent_type: "<name>")`
  // and SDK applies the persona's tools/model/system-prompt frontmatter.
  //
  // Files live at project root (not under .claude/) to keep NanoClaw infra
  // distinct from any project-level .claude/agents/ a developer may add
  // for their own subagents. The destination still lands in the SDK-
  // standard location so discovery works.
  //
  // Status gate: only personas with `status: confirmed` (or no status
  // field — backward compat) get synced. Pendings created via the
  // `add_persona` MCP tool stay on disk but never become spawnable until
  // an admin/is_main agent confirms them via the pending-confirmations
  // procedure (see rules/admin/pending-confirmations.md).
  const personasSrc = path.join(process.cwd(), 'personas');
  const agentsDst = path.join(groupSessionsDir, 'agents');
  if (fs.existsSync(personasSrc)) {
    fs.mkdirSync(agentsDst, { recursive: true });
    for (const file of fs.readdirSync(personasSrc)) {
      if (!file.endsWith('.md')) continue;
      const srcPath = path.join(personasSrc, file);
      // Cheap frontmatter status sniff — read just the head, not whole
      // file. Personas are small but this keeps the per-spawn cost flat
      // even if the library grows.
      let head = '';
      try {
        const fd = fs.openSync(srcPath, 'r');
        const buf = Buffer.alloc(1024);
        const bytes = fs.readSync(fd, buf, 0, 1024, 0);
        fs.closeSync(fd);
        head = buf.subarray(0, bytes).toString('utf-8');
      } catch {
        continue;
      }
      const statusMatch = head.match(/^status:\s*(\S+)/m);
      const status = statusMatch?.[1];
      if (status && status !== 'confirmed') continue;
      fs.cpSync(srcPath, path.join(agentsDst, file));
    }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      newestMtimeMs(agentRunnerSrc) > newestMtimeMs(groupAgentRunnerDir);
    if (needsCopy) {
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      // Exclude test files — vitest is a host-side devDep, the container's
      // tsc will fail with "Cannot find module 'vitest'" if a *.test.ts
      // makes it into /app/src.
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
        recursive: true,
        filter: (src) => !src.endsWith('.test.ts'),
      });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  trustLevel: TrustLevel,
  groupFolder: string,
  useMcpGateway: boolean,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // SDK default-model overrides (host .env) — propagated to container env
  // further down so the Claude Agent SDK picks them up at query time.
  const envOverrides = readEnvFile([
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'LLM_BACKEND',
  ]);

  // Tell agent-runner which backend it's effectively talking to. The
  // runner uses this to apply OR-specific quirks (e.g. disabling
  // extended thinking; see the disableThinking gate in
  // container/agent-runner/src/index.ts).
  const backend = envOverrides.LLM_BACKEND || process.env.LLM_BACKEND;
  if (backend) args.push('-e', `LLM_BACKEND=${backend}`);

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass trust level so agent-runner can apply tool/MCP restrictions
  args.push('-e', `NANOCLAW_TRUST_LEVEL=${trustLevel}`);

  // MCP Gateway A/B: when enabled for this group, request a token from the
  // host gateway and inject it into the container so the gateway-client
  // shim can authenticate. The shim becomes the single source of MCP tools
  // (agent-runner skips its 6 direct credentialed entries).
  if (useMcpGateway) {
    const gw = getGatewayInstance();
    if (!gw) {
      logger.warn(
        { groupFolder },
        'useMcpGateway=true but gateway not running; falling back to direct MCPs',
      );
    } else {
      const issued = gw.issueTokenInProcess(groupFolder, trustLevel);
      args.push(
        '-e',
        `MCP_GATEWAY_URL=http://${CONTAINER_HOST_GATEWAY}:${MCP_GATEWAY_PORT}`,
      );
      args.push('-e', `MCP_GATEWAY_TOKEN=${issued.token}`);
      args.push('-e', `MCP_GATEWAY_GROUP=${groupFolder}`);
    }
  }

  // Model failover chain. The first attempt uses whatever the SDK picks
  // (no explicit model override). Only when that attempt hits a rate limit
  // does the agent-runner walk this priority list.
  // Host filters out currently-exhausted models before passing — if a
  // model we'd try is known to be rate-limited (recorded on a prior
  // turn), skip it so we don't burn another retry on it.
  const fallbackChain = getFallbackChain();
  if (fallbackChain.length > 0) {
    args.push('-e', `NANOCLAW_MODEL_PRIORITY=${fallbackChain.join(',')}`);
  }

  // SDK default-model overrides — propagate from host env to container.
  // The Claude Agent SDK reads these to override its built-in defaults
  // for each tier. Useful when LLM_BACKEND=openrouter to force a
  // non-Anthropic model (e.g. z-ai/glm-4.6v) instead of falling back
  // to the SDK's hardcoded Sonnet/Opus/Haiku names.
  for (const k of [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ] as const) {
    const v = process.env[k] || envOverrides[k];
    if (v) args.push('-e', `${k}=${v}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const groupTrustLevel = getTrustLevel(group);
  const useMcpGateway = group.containerConfig?.useMcpGateway ?? false;
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    groupTrustLevel,
    group.folder,
    useMcpGateway,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output OR
    // any IPC processed for this group — see bumpContainerActivity).
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };
    // Register so the IPC watcher can keep the watchdog quiet while the
    // agent is busy in long-running tool calls (Bash, SQL, MCP) that
    // don't stream stdout but do emit IPC events along the way.
    activeTimeoutResetters.set(group.folder, resetTimeout);

    container.on('close', (code) => {
      activeTimeoutResetters.delete(group.folder);
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
          exitCode: code,
          killedByTimeout: true,
          stderr: stderr.slice(-4000),
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          exitCode: code,
          killedByTimeout: false,
          stderr: stderr.slice(-4000),
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
