import request from 'supertest';
import { createClient } from 'redis';
import { createRuntimeConfig } from '../src/config';
import { createHttpRuntime, HttpRuntime } from '../src/http-server';
import { logger } from '../src/logger';
import { RedisBrokerStore } from '../src/redis-broker-store';
import { WaiterRegistry } from '../src/waiter-registry';
import { RedisWakeBus } from '../src/wake-bus';

const redisTestUrl = process.env['A2A_TEST_REDIS_URL'];
const describeIfRedis = redisTestUrl ? describe : describe.skip;

interface RedisRuntimeHandle {
  runtime: HttpRuntime;
  store: RedisBrokerStore;
}

async function flushRedis(url: string): Promise<void> {
  const client = createClient({ url });
  await client.connect();
  try {
    await client.flushDb();
  } finally {
    await client.quit();
  }
}

async function createRedisRuntime(instanceId: string): Promise<RedisRuntimeHandle> {
  const config = createRuntimeConfig({
    NODE_ENV: 'development',
    BROKER_STORE: 'redis',
    REDIS_URL: redisTestUrl,
    LOOKUP_HMAC_KEY: 'r'.repeat(32),
    INSTANCE_ID: instanceId,
    ADMIN_TOKEN: 'admin-secret',
  });
  const store = new RedisBrokerStore(config);
  await store.connect();
  const runtime = createHttpRuntime({
    config,
    runtimeLogger: logger,
    store,
    waiters: new WaiterRegistry(),
    wakeBus: new RedisWakeBus(config, logger),
  });
  await runtime.initialize();
  return { runtime, store };
}

describeIfRedis('Redis runtime integration', () => {
  let runtimeA!: RedisRuntimeHandle;
  let runtimeB!: RedisRuntimeHandle;

  beforeEach(async () => {
    await flushRedis(redisTestUrl as string);
    runtimeA = await createRedisRuntime('instance-a');
    runtimeB = await createRedisRuntime('instance-b');
  });

  afterEach(async () => {
    await Promise.allSettled([
      runtimeA?.runtime.close() ?? Promise.resolve(),
      runtimeB?.runtime.close() ?? Promise.resolve(),
    ]);
    await flushRedis(redisTestUrl as string);
  });

  it('supports create on one instance and register-and-join on another', async () => {
    const setup = await request(runtimeA.runtime.app)
      .post('/setup')
      .set('Content-Type', 'application/json')
      .send({ type: 'standard', headless: false });

    const join = await request(runtimeB.runtime.app)
      .post(`/register-and-join/${setup.body.code}`);

    expect(setup.status).toBe(200);
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('(2/2 connected)');
    expect(join.body.role).toBe('joiner');
  });

  it('delivers wait wake-ups across instances', async () => {
    const setup = await request(runtimeA.runtime.app)
      .post('/setup')
      .set('Content-Type', 'application/json')
      .send({ type: 'standard', headless: false });

    const join = await request(runtimeB.runtime.app)
      .post(`/register-and-join/${setup.body.code}`);

    expect(join.status).toBe(200);

    const waitPromise = request(runtimeB.runtime.app)
      .get('/wait')
      .set('Authorization', `Bearer ${join.body.token as string}`);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const send = await request(runtimeA.runtime.app)
      .post('/send')
      .set('Authorization', `Bearer ${setup.body.token as string}`)
      .set('Content-Type', 'text/plain')
      .send('cross-instance ping [OVER]');

    const waitRes = await waitPromise;

    expect(send.status).toBe(200);
    expect(send.text).toBe('DELIVERED');
    expect(waitRes.status).toBe(200);
    expect(waitRes.text).toContain('cross-instance ping');
  });

  it('wakes cross-instance waiters when admin invalidates a room', async () => {
    const setup = await request(runtimeA.runtime.app)
      .post('/setup')
      .set('Content-Type', 'application/json')
      .send({ type: 'standard', headless: false });

    const join = await request(runtimeB.runtime.app)
      .post(`/register-and-join/${setup.body.code}`);

    const waitPromise = request(runtimeB.runtime.app)
      .get('/wait')
      .set('Authorization', `Bearer ${join.body.token as string}`);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const invalidate = await request(runtimeA.runtime.app)
      .post('/admin/invalidate')
      .set('Authorization', 'Bearer admin-secret')
      .set('Content-Type', 'application/json')
      .send({ roomName: setup.body.roomName });

    const waitRes = await waitPromise;

    expect(invalidate.status).toBe(200);
    expect(waitRes.status).toBe(200);
    expect(waitRes.text).toContain('Session was closed by broker policy');
  });

  it('shares rate limit counters across Redis store instances', async () => {
    const decisionA = await runtimeA.store.consumeRateLimit('shared-test', 'shared-key', 60_000, 2);
    const decisionB = await runtimeB.store.consumeRateLimit('shared-test', 'shared-key', 60_000, 2);
    const decisionC = await runtimeA.store.consumeRateLimit('shared-test', 'shared-key', 60_000, 2);

    expect(decisionA).toEqual({ allowed: true });
    expect(decisionB).toEqual({ allowed: true });
    expect(decisionC.allowed).toBe(false);
  });

  it('preserves inline signal markers and uses only a trailing transport marker in the Redis store', async () => {
    const setup = await runtimeA.store.setupSession('standard', false);
    expect(setup).not.toBeNull();
    const join = await runtimeB.store.registerAndJoin((setup as NonNullable<typeof setup>).code);
    expect(join).not.toBe('invalid_code');
    expect(typeof join).not.toBe('string');

    const send = await runtimeA.store.sendMessage(
      (setup as NonNullable<typeof setup>).token,
      'Visible <code>[STANDBY]</code> marker [OVER]',
    );

    expect(send.kind).toBe('delivered');
    const delivered = await runtimeB.store.consumeInbox((join as Exclude<typeof join, string>).token);
    expect(delivered).toContain('<code>[STANDBY]</code>');
    expect(delivered).toMatch(/^MESSAGE_RECEIVED\n┌─ [^\n]+ \[OVER\]\n/m);

    const senderRecord = await (runtimeA.store as any).getToken((setup as NonNullable<typeof setup>).token);
    expect(senderRecord.standby).toBe(false);
  });

  it('explicitly clears stale sender standby state when a Redis-store message has no trailing marker', async () => {
    const setup = await runtimeA.store.setupSession('standard', false);
    expect(setup).not.toBeNull();
    const join = await runtimeB.store.registerAndJoin((setup as NonNullable<typeof setup>).code);
    expect(join).not.toBe('invalid_code');
    expect(typeof join).not.toBe('string');

    await runtimeA.store.sendMessage((setup as NonNullable<typeof setup>).token, 'Waiting for the next chunk [STANDBY]');
    await runtimeB.store.consumeInbox((join as Exclude<typeof join, string>).token);

    let senderRecord = await (runtimeA.store as any).getToken((setup as NonNullable<typeof setup>).token);
    expect(senderRecord.standby).toBe(true);

    await runtimeA.store.sendMessage(
      (setup as NonNullable<typeof setup>).token,
      'Visible [STANDBY] marker inside body with no trailing transport signal',
    );
    const delivered = await runtimeB.store.consumeInbox((join as Exclude<typeof join, string>).token);

    expect(delivered).toContain('Visible [STANDBY] marker inside body with no trailing transport signal');
    expect(delivered).toMatch(/^MESSAGE_RECEIVED\n┌─ [^\n\[]+\n/m);

    senderRecord = await (runtimeA.store as any).getToken((setup as NonNullable<typeof setup>).token);
    expect(senderRecord.standby).toBe(false);
  });
});
