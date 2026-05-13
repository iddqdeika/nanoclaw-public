import fs from 'fs';
import path from 'path';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

// Under PM2 on Windows, process.stdout/stderr writes go through PM2's pipe
// which frequently blocks or deadlocks, freezing the entire event loop and
// killing all connections (Slack, Telegram, etc.) simultaneously.
// When running under PM2, write directly to a log file instead.
// Always write logs to a file. This prevents PM2's broken stdout pipe on Windows
// from blocking the event loop (which kills Slack/Telegram connections).
// Also write to stdout when running interactively (TTY).
const LOG_FILE = path.join(process.cwd(), 'data', 'nanoclaw.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logFd = fs.openSync(LOG_FILE, 'a');
const isTty = process.stdout.isTTY;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const line =
    typeof dataOrMsg === 'string'
      ? `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`
      : `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`;

  fs.writeSync(logFd, line);
  if (isTty) {
    const stream =
      LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    stream.write(line);
  }
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
