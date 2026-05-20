/**
 * Error classifier for the recovery system.
 *
 * Takes raw signals from a failed turn (container exit code, stderr,
 * SDK stream errors, IPC messages) and produces a structured error type
 * that the retry policy can act on.
 *
 * Seven canonical error types — keep this list in sync with retry-policy.ts:
 *
 *  - network         — TCP / DNS / TLS to the LLM provider or MCP gateway
 *                      failed. Transient. Adaptive exp backoff up to 24h.
 *  - rate_limit      — Provider 429 (Anthropic native, OpenRouter envelope,
 *                      or upstream-via-OR). May include resets_at from
 *                      header. Wait until resets_at, then retry. 24h cap.
 *  - upstream_5xx    — Provider 5xx (Anthropic, OpenRouter, MCP gateway).
 *                      Transient. Adaptive exp backoff up to 24h.
 *  - auth_401        — Token expired, invalid_grant, billing unconfigured.
 *                      Needs human action. 30s then 1 retry, fail.
 *  - auth_403        — Insufficient scope, forbidden, or OpenRouter 402
 *                      "out of credits". Needs human action. 30s then 1
 *                      retry, fail.
 *  - validation_400  — Malformed request / schema violation.
 *                      Usually a bug. 60s then 1 retry, fail.
 *  - validation_404  — Endpoint / resource gone.
 *                      Usually a bug. 60s then 1 retry, fail.
 *  - crash           — Container exited non-zero, OOM, panic.
 *                      3 retries with 1min spacing, fail.
 *  - idle_timeout    — Container hit the watchdog (no stdout / no IPC
 *                      activity within IDLE_TIMEOUT).
 *                      30s then 1 retry, fail (likely same long tool call).
 *  - unknown         — Nothing matched. Treated as crash conservatively.
 */

export type ErrorType =
  | 'network'
  | 'rate_limit'
  | 'upstream_5xx'
  | 'auth_401'
  | 'auth_403'
  | 'validation_400'
  | 'validation_404'
  | 'crash'
  | 'idle_timeout'
  | 'unknown';

export interface ClassifiedError {
  type: ErrorType;
  /** Anthropic rate-limit header `resets_at` ISO timestamp, if present. */
  resets_at?: string;
  /** Short human-readable description for the give-up message. */
  description: string;
  /** Raw error blob for logging / forensics. */
  raw?: string;
}

export interface ClassifierInput {
  /** Container exit code (null if container didn't spawn / still running). */
  exitCode?: number | null;
  /** Whether the container was killed by the idle-timeout watchdog. */
  killedByTimeout?: boolean;
  /** Captured stderr from the container (truncated if huge). */
  stderr?: string;
  /** Captured stdout fragment that may carry SDK error text. */
  stdout?: string;
  /** Explicit error string emitted via IPC model_exhausted / similar. */
  ipcError?: string;
  /** Rate-limit metadata captured by agent-runner. */
  rateLimit?: {
    resetsAt?: string;
    rateLimitType?: string;
  };
}

const PATTERN = {
  // Network — connection-level failures before HTTP layer
  network:
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|certificate has expired|TLS handshake|getaddrinfo|socket hang up|network request failed|fetch failed/i,
  // Rate limit — Anthropic-native + generic HTTP 429 + OpenRouter envelope
  rate_limit:
    /rate[ _-]?limit|\b429\b|429 Too Many Requests|rate_limit_exceeded|"type":"rate_limit_error"|"code":\s*429/i,
  // Upstream 5xx — Anthropic-native + OpenRouter envelope (code in body)
  upstream_5xx:
    /\b50[0-9]\b|"type":"api_error"|"type":"overloaded_error"|"code":\s*50[0-9]|Service Unavailable|Internal Server Error|Bad Gateway|Gateway Timeout/i,
  // Auth (needs human action — invalid key, expired token, no credits)
  // 402 (OpenRouter "Out of credits") and "insufficient_credits" land here
  // because the retry policy for auth_403 matches what we want for credit
  // exhaustion: short backoff, 1 retry, then surface to user.
  auth_401:
    /\b401\b|invalid_grant|invalid_api_key|"type":"authentication_error"|Unauthorized|token.{0,20}expired|invalid_token|invalid_client|"code":\s*401|No auth credentials/i,
  auth_403:
    /\b40[23]\b|"type":"permission_error"|Forbidden|insufficient_scope|access[_ ]denied|"code":\s*40[23]|insufficient_credits|Out of credits|quota[_ ]exceeded/i,
  // Validation
  validation_400:
    /\b400\b|"type":"invalid_request_error"|Bad Request|schema validation|invalid_request|"code":\s*400/i,
  validation_404:
    /\b404\b|"type":"not_found_error"|Not Found|no such (endpoint|resource)|"code":\s*404|model.{0,20}not.{0,20}found/i,
};

export function classifyError(input: ClassifierInput): ClassifiedError {
  // Idle timeout — explicit signal from the watchdog, takes precedence.
  if (input.killedByTimeout) {
    return {
      type: 'idle_timeout',
      description:
        'agent took longer than the idle watchdog allows (likely stuck in a long tool call)',
      raw: input.stderr || input.stdout || undefined,
    };
  }

  // Rate limit — agent-runner already extracts resets_at; prefer that over regex.
  if (input.rateLimit?.resetsAt) {
    return {
      type: 'rate_limit',
      resets_at: input.rateLimit.resetsAt,
      description: `upstream rate limit (${input.rateLimit.rateLimitType || 'unspecified'}); waits until ${input.rateLimit.resetsAt}`,
    };
  }

  const haystack = [input.stderr, input.stdout, input.ipcError]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n');

  if (haystack) {
    if (PATTERN.network.test(haystack)) {
      return {
        type: 'network',
        description:
          'network connection failure (no route, DNS, TLS, or connection reset)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.rate_limit.test(haystack)) {
      return {
        type: 'rate_limit',
        description: 'upstream rate limit (LLM provider or MCP gateway)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.upstream_5xx.test(haystack)) {
      return {
        type: 'upstream_5xx',
        description:
          'upstream server error (LLM provider or MCP gateway returned 5xx)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.auth_401.test(haystack)) {
      return {
        type: 'auth_401',
        description:
          'authentication failed (token expired, invalid, or billing unconfigured)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.auth_403.test(haystack)) {
      return {
        type: 'auth_403',
        description: 'access forbidden (insufficient scope or permission)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.validation_400.test(haystack)) {
      return {
        type: 'validation_400',
        description: 'invalid request (malformed payload or schema violation)',
        raw: haystack.slice(0, 500),
      };
    }
    if (PATTERN.validation_404.test(haystack)) {
      return {
        type: 'validation_404',
        description: 'resource not found',
        raw: haystack.slice(0, 500),
      };
    }
  }

  // Container died but no recognizable pattern — treat as crash.
  if (input.exitCode != null && input.exitCode !== 0) {
    return {
      type: 'crash',
      description: `container exited with non-zero status ${input.exitCode}`,
      raw: haystack ? haystack.slice(0, 500) : undefined,
    };
  }

  return {
    type: 'unknown',
    description: 'unknown failure (no recognizable pattern in stderr/stdout)',
    raw: haystack ? haystack.slice(0, 500) : undefined,
  };
}
