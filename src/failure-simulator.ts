/**
 * Failure simulation for recovery-system testing.
 *
 * Admin-only MCP tool writes a "next turn for group X should fail with
 * error type Y" record. Orchestrator reads it before spawning a container
 * and short-circuits with a synthesized ContainerOutput carrying the
 * requested error shape — so the classifier / retry policy / sweep loop
 * all see a realistic failure pattern without needing real outages.
 *
 * Backed by a JSON file (store/failure-simulations.json) so simulations
 * survive orchestrator restarts when you want to test boot-hook recovery.
 *
 * Single-use per (group_folder): consumed on first read, cleared from disk.
 */

import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { ContainerOutput } from './container-runner.js';
import { ErrorType } from './error-classifier.js';
import { logger } from './logger.js';

const FILE = path.join(STORE_DIR, 'failure-simulations.json');

interface SimulationEntry {
  errorType: ErrorType;
  /** Pretend container exited with this code (default per type). */
  exitCode?: number;
  /** Pretend the container was killed by the idle watchdog. */
  killedByTimeout?: boolean;
  /** Stderr content to feed the classifier (default per type). */
  stderr?: string;
  /** ISO timestamp; matched against resets_at for rate_limit. */
  resetsAt?: string;
  /** When the sim was written. */
  createdAt: string;
}

type SimMap = Record<string, SimulationEntry>;

function readAll(): SimMap {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeAll(m: SimMap): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(m, null, 2));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'failure-simulator: write failed',
    );
  }
}

export function setFailureSimulation(
  groupFolder: string,
  entry: Omit<SimulationEntry, 'createdAt'>,
): void {
  const all = readAll();
  all[groupFolder] = { ...entry, createdAt: new Date().toISOString() };
  writeAll(all);
  logger.info({ groupFolder, entry }, 'failure-simulator: armed');
}

export function clearFailureSimulation(groupFolder: string): void {
  const all = readAll();
  if (delete all[groupFolder]) writeAll(all);
}

/**
 * Check if a simulation is queued for this group and, if so, consume it
 * and return the synthesized ContainerOutput. Returns null otherwise —
 * caller spawns a real container.
 */
export function consumeFailureSimulation(
  groupFolder: string,
): ContainerOutput | null {
  const all = readAll();
  const sim = all[groupFolder];
  if (!sim) return null;
  delete all[groupFolder];
  writeAll(all);
  logger.warn(
    { groupFolder, errorType: sim.errorType },
    'failure-simulator: consumed — synthesizing fake container output',
  );

  return synthesizeOutput(sim);
}

/** Pure: build a ContainerOutput that looks like a real failure of `type`. */
function synthesizeOutput(sim: SimulationEntry): ContainerOutput {
  const defaults: Record<ErrorType, { exitCode: number; stderr: string }> = {
    network: {
      exitCode: 1,
      stderr:
        'fetch failed: getaddrinfo ENOTFOUND api.anthropic.com\n    at request (node:internal/...)',
    },
    rate_limit: {
      exitCode: 1,
      stderr:
        '{"type":"rate_limit_error","message":"Number of request tokens has exceeded your daily rate limit (...)"}',
    },
    upstream_5xx: {
      exitCode: 1,
      stderr:
        '{"type":"overloaded_error","message":"Anthropic is currently overloaded — please retry"}',
    },
    auth_401: {
      exitCode: 1,
      stderr:
        '{"type":"authentication_error","message":"invalid x-api-key"} — 401 Unauthorized',
    },
    auth_403: {
      exitCode: 1,
      stderr:
        '{"type":"permission_error","message":"403 Forbidden — insufficient scope"}',
    },
    validation_400: {
      exitCode: 1,
      stderr:
        '{"type":"invalid_request_error","message":"messages.0: schema validation failed"} — 400 Bad Request',
    },
    validation_404: {
      exitCode: 1,
      stderr: '404 Not Found — endpoint /v1/blah does not exist',
    },
    crash: {
      exitCode: 137,
      stderr:
        'Container hit OOM, killed by kernel.\n(no SDK error pattern recognizable)',
    },
    idle_timeout: { exitCode: 143, stderr: '' },
    unknown: { exitCode: 1, stderr: 'something opaque went wrong' },
  };

  const d = defaults[sim.errorType];
  return {
    status: 'error',
    result: null,
    error: `simulated ${sim.errorType}`,
    exitCode: sim.exitCode ?? d.exitCode,
    killedByTimeout:
      sim.killedByTimeout ?? sim.errorType === 'idle_timeout',
    stderr: sim.stderr ?? d.stderr,
  };
}
