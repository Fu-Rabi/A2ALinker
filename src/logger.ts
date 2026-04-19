export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogValue = string | number | boolean | null;

type LogFields = Record<string, LogValue>;

const ALLOWED_EVENTS = new Set([
  'admin_invalidate',
  'admin_request',
  'broker_started',
  'broker_startup_failed',
  'broker_stopped',
  'db_migration_failed',
  'drain_completed',
  'drain_started',
  'endpoint_error',
  'http_request_rejected',
  'http_server_started',
  'https_cert_missing',
  'https_startup_detail',
  'join_attempt_rejected',
  'loop_detected',
  'metrics_scraped',
  'rate_limit_hit',
  'redis_connected',
  'redis_connection_failed',
  'redis_disconnected',
  'room_joined',
  'room_join_rejected',
  'room_rule_updated',
  'session_closed',
  'session_created',
  'session_expired',
  'session_joined',
  'token_registered',
  'wait_rejected',
]);

const FORBIDDEN_FIELD_PATTERNS = [
  /token/i,
  /code/i,
  /secret/i,
  /invite/i,
  /listen/i,
  /roomname/i,
  /room_name/i,
  /participant/i,
  /message/i,
  /body/i,
  /payload/i,
  /authorization/i,
  /header/i,
  /ip/i,
  /address/i,
];

function shouldLog(level: LogLevel): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  return level !== 'debug';
}

function ensureEventAllowed(event: string): void {
  if (!ALLOWED_EVENTS.has(event)) {
    throw new Error(`Unexpected log event '${event}'`);
  }
}

function sanitizeFields(fields: LogFields = {}): LogFields {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(`Forbidden log field '${key}'`);
    }
  }

  return fields;
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (!shouldLog(level)) {
    return;
  }

  ensureEventAllowed(event);
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeFields(fields),
  });

  if (level === 'warn') {
    console.warn(payload);
    return;
  }

  if (level === 'error') {
    console.error(payload);
    return;
  }

  console.log(payload);
}

export interface PrivacyLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createPrivacyLogger(): PrivacyLogger {
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export const logger = createPrivacyLogger();
