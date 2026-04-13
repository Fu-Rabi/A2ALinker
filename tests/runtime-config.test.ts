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
});
