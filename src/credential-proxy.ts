/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Reads access/refresh tokens from ~/.claude/.credentials.json.
 *             Auto-refreshes the access token when it nears expiry.
 *             Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// OAuth refresh constants (extracted from Claude Code CLI source)
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Read OAuth credentials from ~/.claude/.credentials.json */
function readCredentialsFile(): OAuthCredentials | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const oauth = data.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken && oauth?.expiresAt) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
    }
  } catch {
    // File missing or malformed
  }
  return null;
}

/** Write refreshed credentials back to ~/.claude/.credentials.json */
function writeCredentialsFile(creds: OAuthCredentials): void {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    } catch {
      // Start fresh
    }
    const existing =
      (data.claudeAiOauth as Record<string, unknown> | undefined) || {};
    data.claudeAiOauth = {
      ...existing,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
    fs.writeFileSync(credPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err }, 'Failed to write refreshed credentials');
  }
}

/** Refresh the OAuth access token using the refresh token */
async function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });

    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.access_token) {
              const expiresAt = data.expires_in
                ? Date.now() + data.expires_in * 1000
                : Date.now() + 3600 * 1000; // Default 1hr
              resolve({
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken,
                expiresAt,
              });
            } else {
              logger.warn(
                { error: data.error },
                'OAuth refresh returned no access_token',
              );
              resolve(null);
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse OAuth refresh response');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh request failed');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // OAuth state: mutable, refreshed as needed
  let oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN || '';
  let oauthRefreshToken = '';
  let oauthExpiresAt = 0;
  let refreshInFlight: Promise<boolean> | null = null;

  // Bootstrap from credentials file if available
  if (authMode === 'oauth') {
    const creds = readCredentialsFile();
    if (creds) {
      oauthToken = creds.accessToken;
      oauthRefreshToken = creds.refreshToken;
      oauthExpiresAt = creds.expiresAt;
      logger.info(
        {
          expiresAt: new Date(creds.expiresAt).toISOString(),
          hasRefreshToken: true,
        },
        'Loaded OAuth credentials from credentials file',
      );
    } else if (oauthToken) {
      logger.info(
        'Using OAuth token from .env (no refresh token — manual re-auth needed on expiry)',
      );
    }
  }

  /** Ensure the OAuth token is fresh. Returns true if token is valid. */
  async function ensureFreshToken(): Promise<boolean> {
    if (authMode !== 'oauth' || !oauthRefreshToken) return !!oauthToken;

    const now = Date.now();
    if (oauthExpiresAt > now + REFRESH_BUFFER_MS) return true; // Still valid

    // Coalesce concurrent refresh attempts
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      logger.info('OAuth token near expiry, refreshing...');
      const newCreds = await refreshOAuthToken(oauthRefreshToken);
      if (newCreds) {
        oauthToken = newCreds.accessToken;
        oauthRefreshToken = newCreds.refreshToken;
        oauthExpiresAt = newCreds.expiresAt;
        writeCredentialsFile(newCreds);
        logger.info(
          { expiresAt: new Date(newCreds.expiresAt).toISOString() },
          'OAuth token refreshed successfully',
        );
        return true;
      }
      // Refresh failed — re-read credentials file in case Claude Code CLI
      // refreshed it externally (e.g. user ran a claude command)
      const fileCreds = readCredentialsFile();
      if (fileCreds && fileCreds.expiresAt > now + REFRESH_BUFFER_MS) {
        oauthToken = fileCreds.accessToken;
        oauthRefreshToken = fileCreds.refreshToken;
        oauthExpiresAt = fileCreds.expiresAt;
        logger.info(
          'OAuth refresh failed but credentials file has fresh token',
        );
        return true;
      }
      logger.error(
        'OAuth refresh failed and no fresh credentials available. Run: claude auth login',
      );
      return false;
    })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // Ensure token is fresh before forwarding
        if (authMode === 'oauth') {
          await ensureFreshToken();
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
