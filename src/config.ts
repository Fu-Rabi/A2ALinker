import crypto from 'crypto';

export interface RuntimeConfig {
  nodeEnv: string;
  instanceId: string;
  isProduction: boolean;
  storeBackend: 'memory' | 'redis';
  redisUrl: string | null;
  lookupHmacKey: Buffer;
  adminToken: string | null;
  trustProxy: boolean | number | string;
  httpBindHost: string;
  httpPort: number;
  allowInsecureHttpLocalDev: boolean;
  allowDirectHttpsProduction: boolean;
  httpsKeyPath: string | null;
  httpsCertPath: string | null;
  drainTimeoutMs: number;
  waitTimeoutMs: number;
  tokenTtlMs: number;
  codeTtlMs: number;
  waitingRoomTtlMs: number;
  sessionIdleTtlMs: number;
  waiterTtlMs: number;
  inboxTtlMs: number;
  loopCounterTtlMs: number;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value '${value}'`);
  }

  return parsed;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  const asNumber = Number.parseInt(value, 10);
  if (!Number.isNaN(asNumber)) {
    return asNumber;
  }

  return value;
}

function parseLookupKey(value: string | undefined, isProduction: boolean): Buffer {
  if (!value) {
    if (isProduction) {
      throw new Error('LOOKUP_HMAC_KEY is required in production');
    }

    return crypto.randomBytes(32);
  }

  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length < 32) {
    throw new Error('LOOKUP_HMAC_KEY must be at least 32 bytes');
  }

  return buffer;
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const storeBackend = (env.BROKER_STORE ?? (isProduction ? 'redis' : 'memory')) as 'memory' | 'redis';
  const redisUrl = env.REDIS_URL ?? null;

  if (storeBackend === 'redis' && !redisUrl) {
    throw new Error('REDIS_URL is required when BROKER_STORE=redis');
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (isProduction && trustProxy === false) {
    throw new Error('TRUST_PROXY is required in production');
  }

  const httpBindHost = env.HTTP_BIND_HOST ?? (isProduction ? '127.0.0.1' : '0.0.0.0');
  const allowDirectHttpsProduction = env.ALLOW_DIRECT_HTTPS_PROD === 'true';
  if (isProduction && (env.HTTPS_KEY_PATH || env.HTTPS_CERT_PATH) && !allowDirectHttpsProduction) {
    throw new Error('Direct HTTPS termination is disabled in production; use a reverse proxy or set ALLOW_DIRECT_HTTPS_PROD=true');
  }

  return {
    nodeEnv,
    instanceId: env.INSTANCE_ID ?? crypto.randomUUID(),
    isProduction,
    storeBackend,
    redisUrl,
    lookupHmacKey: parseLookupKey(env.LOOKUP_HMAC_KEY, isProduction),
    adminToken: env.ADMIN_TOKEN ?? null,
    trustProxy,
    httpBindHost,
    httpPort: parseInteger(env.HTTP_PORT, 3000),
    allowInsecureHttpLocalDev: env.ALLOW_INSECURE_HTTP_LOCAL_DEV === 'true',
    allowDirectHttpsProduction,
    httpsKeyPath: env.HTTPS_KEY_PATH ?? null,
    httpsCertPath: env.HTTPS_CERT_PATH ?? null,
    drainTimeoutMs: parseInteger(env.DRAIN_TIMEOUT_MS, 25_000),
    waitTimeoutMs: parseInteger(env.WAIT_TIMEOUT_MS, 110_000),
    tokenTtlMs: parseInteger(env.TOKEN_TTL_MS, 15 * 60 * 1000),
    codeTtlMs: parseInteger(env.CODE_TTL_MS, 15 * 60 * 1000),
    waitingRoomTtlMs: parseInteger(env.WAITING_ROOM_TTL_MS, 15 * 60 * 1000),
    sessionIdleTtlMs: parseInteger(env.SESSION_IDLE_TTL_MS, 30 * 60 * 1000),
    waiterTtlMs: parseInteger(env.WAITER_TTL_MS, 115_000),
    inboxTtlMs: parseInteger(env.INBOX_TTL_MS, 30 * 60 * 1000),
    loopCounterTtlMs: parseInteger(env.LOOP_COUNTER_TTL_MS, 5 * 60 * 1000),
  };
}
