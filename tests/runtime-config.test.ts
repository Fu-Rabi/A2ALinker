import { createRuntimeConfig } from '../src/config';

describe('Runtime config', () => {
  it('defaults production app binding to loopback', () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'production',
      BROKER_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
      TRUST_PROXY: '1',
    });

    expect(config.httpBindHost).toBe('127.0.0.1');
  });

  it('defaults development app binding to all interfaces', () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'development',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
    });

    expect(config.httpBindHost).toBe('0.0.0.0');
  });

  it('rejects direct HTTPS termination in production unless explicitly allowed', () => {
    expect(() => createRuntimeConfig({
      NODE_ENV: 'production',
      BROKER_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
      TRUST_PROXY: '1',
      HTTPS_KEY_PATH: '/tmp/test.key',
      HTTPS_CERT_PATH: '/tmp/test.crt',
    })).toThrow('Direct HTTPS termination is disabled in production');
  });

  it('allows direct HTTPS termination in production only with an explicit override', () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'production',
      BROKER_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
      TRUST_PROXY: '1',
      HTTPS_KEY_PATH: '/tmp/test.key',
      HTTPS_CERT_PATH: '/tmp/test.crt',
      ALLOW_DIRECT_HTTPS_PROD: 'true',
    });

    expect(config.allowDirectHttpsProduction).toBe(true);
  });

  it('defaults headless listener pre-connect TTLs to 6 hours', () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'development',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
    });

    expect(config.headlessListenerCodeTtlMs).toBe(6 * 60 * 60 * 1000);
    expect(config.headlessListenerWaitingRoomTtlMs).toBe(6 * 60 * 60 * 1000);
  });

  it('allows overriding headless listener pre-connect TTLs explicitly', () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'development',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'x'.repeat(32),
      HEADLESS_LISTENER_CODE_TTL_MS: '1000',
      HEADLESS_LISTENER_WAITING_ROOM_TTL_MS: '2000',
    });

    expect(config.headlessListenerCodeTtlMs).toBe(1000);
    expect(config.headlessListenerWaitingRoomTtlMs).toBe(2000);
  });
});
