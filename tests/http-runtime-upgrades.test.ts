process.env['DB_PATH'] = ':memory:';

import request from 'supertest';
import { renderAdminClosedMessage } from '../src/broker-messages';
import { createRuntimeConfig } from '../src/config';
import { app, createHttpRuntime } from '../src/http-server';
import { logger } from '../src/logger';
import { MemoryBrokerStore } from '../src/memory-broker-store';
import { renderHttpWalkieTalkieRules } from '../src/protocol';
import { createLookupId } from '../src/runtime-ids';
import { WaiterRegistry } from '../src/waiter-registry';
import { WakeBus, WakeEvent } from '../src/wake-bus';

describe('HTTP runtime upgrades', () => {
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
});
