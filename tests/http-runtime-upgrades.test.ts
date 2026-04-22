import request from 'supertest';
import { renderAdminClosedMessage } from '../src/broker-messages';
import { createRuntimeConfig } from '../src/config';
import { app, createHttpRuntime, startHttpServer } from '../src/http-server';
import { logger } from '../src/logger';
import { MemoryBrokerStore } from '../src/memory-broker-store';
import { renderHttpWalkieTalkieRules } from '../src/protocol';
import { createLookupId } from '../src/runtime-ids';
import { WaiterRegistry } from '../src/waiter-registry';
import { WakeBus, WakeEvent } from '../src/wake-bus';

describe('HTTP runtime upgrades', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports readiness', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('exposes aggregate metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('a2a_active_sessions');
    expect(res.text).toContain('a2a_waits_total');
  });

  it('returns 404 for disabled admin endpoints', async () => {
    const res = await request(app)
      .post('/admin/drain')
      .set('Content-Type', 'application/json')
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it('rejects duplicate waiters in the local registry', () => {
    const waiters = new WaiterRegistry();
    const sent: string[] = [];
    const res = {
      send: (text: string) => {
        sent.push(text);
      },
    } as unknown as Parameters<WaiterRegistry['register']>[1]['res'];
    const timer = setTimeout(() => undefined, 1000);

    expect(waiters.register('lookup_test', { token: 'tok_test', res, timer })).toBe(true);
    expect(waiters.register('lookup_test', { token: 'tok_test', res, timer })).toBe(false);
    expect(waiters.resolve('lookup_test', 'resolved')).toBe(true);
    expect(sent).toEqual(['resolved']);
    clearTimeout(timer);
  });

  it('returns the shared walkie-talkie rules format in join responses', async () => {
    const setup = await request(app)
      .post('/setup')
      .set('Content-Type', 'application/json')
      .send({ type: 'standard', headless: false });

    const join = await request(app)
      .post(`/register-and-join/${setup.body.code}`);

    expect(join.status).toBe(200);
    expect(join.body.rules).toBe(renderHttpWalkieTalkieRules());
  });

  it('publishes wake lookup IDs instead of raw tokens', async () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'k'.repeat(32),
      ADMIN_TOKEN: 'admin-secret',
    });
    const store = new MemoryBrokerStore(config);
    const events: WakeEvent[] = [];
    const wakeBus: WakeBus = {
      async start(): Promise<void> {
        return;
      },
      async publish(event: WakeEvent): Promise<void> {
        events.push(event);
      },
      async close(): Promise<void> {
        return;
      },
    };
    const runtime = createHttpRuntime({
      config,
      runtimeLogger: logger,
      store,
      waiters: new WaiterRegistry(),
      wakeBus,
    });

    try {
      await runtime.initialize();

      const setup = await request(runtime.app)
        .post('/setup')
        .set('Content-Type', 'application/json')
        .send({ type: 'standard', headless: false });

      const join = await request(runtime.app)
        .post(`/register-and-join/${setup.body.code}`);

      expect(join.status).toBe(200);
      expect(events).toEqual([
        { recipientLookupId: createLookupId(setup.body.token as string, config.lookupHmacKey) },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('admin invalidation wakes an active waiter immediately', async () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'z'.repeat(32),
      ADMIN_TOKEN: 'admin-secret',
      WAIT_TIMEOUT_MS: '200',
      WAITER_TTL_MS: '250',
    });
    const store = new MemoryBrokerStore(config);
    let runtimeWakeHandler: ((event: WakeEvent) => Promise<void> | void) | null = null;
    const wakeBus: WakeBus = {
      async start(handler): Promise<void> {
        runtimeWakeHandler = handler;
      },
      async publish(event: WakeEvent): Promise<void> {
        if (runtimeWakeHandler) {
          await runtimeWakeHandler(event);
        }
      },
      async close(): Promise<void> {
        return;
      },
    };
    const runtime = createHttpRuntime({
      config,
      runtimeLogger: logger,
      store,
      waiters: new WaiterRegistry(),
      wakeBus,
    });

    try {
      await runtime.initialize();

      const setup = await request(runtime.app)
        .post('/setup')
        .set('Content-Type', 'application/json')
        .send({ type: 'standard', headless: false });

      const waitPromise = request(runtime.app)
        .get('/wait')
        .set('Authorization', `Bearer ${setup.body.token as string}`);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const invalidate = await request(runtime.app)
        .post('/admin/invalidate')
        .set('Authorization', 'Bearer admin-secret')
        .set('Content-Type', 'application/json')
        .send({ roomName: setup.body.roomName });

      const waitRes = await waitPromise;

      expect(invalidate.status).toBe(200);
      expect(waitRes.status).toBe(200);
      expect(waitRes.text).toBe(renderAdminClosedMessage());
    } finally {
      await runtime.close();
    }
  });

  it('allows plain HTTP startup in production for reverse-proxy deployments', async () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'production',
      BROKER_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      LOOKUP_HMAC_KEY: 'p'.repeat(32),
      TRUST_PROXY: '1',
      HTTP_BIND_HOST: '127.0.0.1',
      HTTP_PORT: '3101',
    });
    const runtime = createHttpRuntime({
      config,
      runtimeLogger: logger,
      store: new MemoryBrokerStore(config),
      waiters: new WaiterRegistry(),
      wakeBus: {
        async start(): Promise<void> {
          return;
        },
        async publish(): Promise<void> {
          return;
        },
        async close(): Promise<void> {
          return;
        },
      },
    });

    let server: Awaited<ReturnType<typeof startHttpServer>> = null;
    try {
      server = await startHttpServer(runtime, config, logger);
      expect(server).not.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      });
      await runtime.close();
    }
  });

  it('keeps headless listener setup alive on the extended pre-connect TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));

    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'h'.repeat(32),
      CODE_TTL_MS: '100',
      WAITING_ROOM_TTL_MS: '100',
      HEADLESS_LISTENER_CODE_TTL_MS: '500',
      HEADLESS_LISTENER_WAITING_ROOM_TTL_MS: '500',
    });
    const store = new MemoryBrokerStore(config);

    const setup = await store.setupSession('listener', true);
    expect(setup).not.toBeNull();

    jest.advanceTimersByTime(150);

    const join = await store.registerAndJoin((setup as NonNullable<typeof setup>).code);
    expect(join).not.toBe('invalid_code');
    if (join !== 'invalid_code') {
      expect(join.role).toBe('host');
      expect(join.headless).toBe(true);
    }
  });

  it('does not extend the pre-connect TTL for interactive listeners or standard rooms', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));

    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'i'.repeat(32),
      CODE_TTL_MS: '100',
      WAITING_ROOM_TTL_MS: '100',
      HEADLESS_LISTENER_CODE_TTL_MS: '500',
      HEADLESS_LISTENER_WAITING_ROOM_TTL_MS: '500',
    });
    const store = new MemoryBrokerStore(config);

    const interactiveListener = await store.setupSession('listener', false);
    const standardHeadless = await store.setupSession('standard', true);

    jest.advanceTimersByTime(150);

    await expect(store.registerAndJoin((interactiveListener as NonNullable<typeof interactiveListener>).code))
      .resolves.toBe('invalid_code');
    await expect(store.registerAndJoin((standardHeadless as NonNullable<typeof standardHeadless>).code))
      .resolves.toBe('invalid_code');
  });

  it('preserves inline signal markers and uses only a trailing transport marker in the memory store', async () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'm'.repeat(32),
    });
    const store = new MemoryBrokerStore(config);

    const setup = await store.setupSession('standard', false);
    expect(setup).not.toBeNull();
    const join = await store.registerAndJoin((setup as NonNullable<typeof setup>).code);
    expect(join).not.toBe('invalid_code');
    expect(typeof join).not.toBe('string');

    const send = await store.sendMessage(
      (setup as NonNullable<typeof setup>).token,
      'Visible <code>[STANDBY]</code> marker [OVER]',
    );

    expect(send.kind).toBe('delivered');
    const delivered = await store.consumeInbox((join as Exclude<typeof join, string>).token);
    expect(delivered).toContain('<code>[STANDBY]</code>');
    expect(delivered).toMatch(/^MESSAGE_RECEIVED\n┌─ [^\n]+ \[OVER\]\n/m);
    expect((store as any).tokens.get((setup as NonNullable<typeof setup>).token).standby).toBe(false);
  });

  it('explicitly clears stale sender standby state when a memory-store message has no trailing marker', async () => {
    const config = createRuntimeConfig({
      NODE_ENV: 'test',
      BROKER_STORE: 'memory',
      LOOKUP_HMAC_KEY: 'n'.repeat(32),
    });
    const store = new MemoryBrokerStore(config);

    const setup = await store.setupSession('standard', false);
    expect(setup).not.toBeNull();
    const join = await store.registerAndJoin((setup as NonNullable<typeof setup>).code);
    expect(join).not.toBe('invalid_code');
    expect(typeof join).not.toBe('string');

    await store.sendMessage((setup as NonNullable<typeof setup>).token, 'Waiting for the next chunk [STANDBY]');
    await store.consumeInbox((join as Exclude<typeof join, string>).token);
    expect((store as any).tokens.get((setup as NonNullable<typeof setup>).token).standby).toBe(true);

    await store.sendMessage(
      (setup as NonNullable<typeof setup>).token,
      'Visible [STANDBY] marker inside body with no trailing transport signal',
    );
    const delivered = await store.consumeInbox((join as Exclude<typeof join, string>).token);

    expect(delivered).toContain('Visible [STANDBY] marker inside body with no trailing transport signal');
    expect(delivered).toMatch(/^MESSAGE_RECEIVED\n┌─ [^\n\[]+\n/m);
    expect((store as any).tokens.get((setup as NonNullable<typeof setup>).token).standby).toBe(false);
  });
});
