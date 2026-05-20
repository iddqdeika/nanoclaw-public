import { describe, it, expect } from 'vitest';
import { classifyError } from './error-classifier.js';

describe('classifyError', () => {
  it('classifies idle timeout from explicit signal', () => {
    const r = classifyError({ killedByTimeout: true });
    expect(r.type).toBe('idle_timeout');
  });

  it('idle_timeout signal beats stderr pattern', () => {
    const r = classifyError({
      killedByTimeout: true,
      stderr: 'ECONNRESET something',
    });
    expect(r.type).toBe('idle_timeout');
  });

  it('classifies rate_limit when resets_at provided', () => {
    const r = classifyError({
      rateLimit: {
        resetsAt: '2026-05-08T12:00:00Z',
        rateLimitType: 'requests',
      },
    });
    expect(r.type).toBe('rate_limit');
    expect(r.resets_at).toBe('2026-05-08T12:00:00Z');
  });

  it('matches network from ECONNREFUSED', () => {
    expect(classifyError({ stderr: 'fetch failed: ECONNREFUSED' }).type).toBe(
      'network',
    );
  });

  it('matches network from ENOTFOUND', () => {
    expect(
      classifyError({
        stderr: 'getaddrinfo ENOTFOUND api.anthropic.com',
      }).type,
    ).toBe('network');
  });

  it('matches rate_limit from stderr 429 pattern', () => {
    expect(classifyError({ stderr: '429 Too Many Requests' }).type).toBe(
      'rate_limit',
    );
  });

  it('matches upstream_5xx from overloaded_error', () => {
    expect(classifyError({ stderr: '"type":"overloaded_error"' }).type).toBe(
      'upstream_5xx',
    );
  });

  it('matches upstream_5xx from numeric 503', () => {
    expect(classifyError({ stderr: 'HTTP 503 Service Unavailable' }).type).toBe(
      'upstream_5xx',
    );
  });

  it('matches auth_401 from invalid_grant', () => {
    expect(classifyError({ stderr: 'invalid_grant' }).type).toBe('auth_401');
  });

  it('matches auth_401 from 401', () => {
    expect(classifyError({ stderr: '401 Unauthorized' }).type).toBe('auth_401');
  });

  it('matches auth_403 from 403', () => {
    expect(classifyError({ stderr: '403 Forbidden' }).type).toBe('auth_403');
  });

  it('matches validation_400 from invalid_request_error', () => {
    expect(
      classifyError({ stderr: '"type":"invalid_request_error"' }).type,
    ).toBe('validation_400');
  });

  it('matches validation_404 from 404', () => {
    expect(classifyError({ stderr: '404 Not Found' }).type).toBe(
      'validation_404',
    );
  });

  it('falls through to crash on non-zero exitCode with no pattern', () => {
    expect(classifyError({ exitCode: 137, stderr: 'OOM killed' }).type).toBe(
      'crash',
    );
  });

  it('falls through to unknown when nothing matches', () => {
    expect(classifyError({}).type).toBe('unknown');
  });

  // OpenRouter envelope shapes — error.code is the OR-side HTTP code,
  // metadata.raw / provider_name often carry the upstream provider's
  // original error verbatim. Patterns should catch the envelope code.
  it('matches OpenRouter 402 (out of credits) as auth_403', () => {
    const orError = JSON.stringify({
      error: { code: 402, message: 'Out of credits. Add funds to continue.' },
    });
    expect(classifyError({ stderr: orError }).type).toBe('auth_403');
  });

  it('matches OpenRouter 429 as rate_limit', () => {
    const orError = JSON.stringify({
      error: {
        code: 429,
        message: 'rate limit exceeded',
        metadata: { provider_name: 'Z.AI' },
      },
    });
    expect(classifyError({ stderr: orError }).type).toBe('rate_limit');
  });

  it('matches OpenRouter 401 (bad key) as auth_401', () => {
    const orError = JSON.stringify({
      error: { code: 401, message: 'No auth credentials found' },
    });
    expect(classifyError({ stderr: orError }).type).toBe('auth_401');
  });

  it('matches OpenRouter "model not found" as validation_404', () => {
    expect(
      classifyError({
        stderr:
          '{"error":{"code":404,"message":"No endpoints found for model z-ai/glm-foo not found"}}',
      }).type,
    ).toBe('validation_404');
  });
});
