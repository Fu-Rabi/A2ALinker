import express, { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import net from 'net';
import { BrokerStore } from './broker-store';
import { createRuntimeConfig, RuntimeConfig } from './config';
import { logger, PrivacyLogger } from './logger';
import { MemoryBrokerStore } from './memory-broker-store';
import { createAnonymousBucketId, createLookupId } from './runtime-ids';
import { WaiterRegistry } from './waiter-registry';
import { MemoryWakeBus, WakeBus } from './wake-bus';
import { renderDrainMessage } from './broker-messages';
import { renderHttpWalkieTalkieRules } from './protocol';

interface HttpRuntimeDeps {
  config: RuntimeConfig;
  runtimeLogger: PrivacyLogger;
  store: BrokerStore;
  waiters: WaiterRegistry;
  wakeBus: WakeBus;
}

export interface HttpRuntime {
  app: express.Express;
  initialize(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
  isDraining(): boolean;
}

function getToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }

  return auth.slice(7);
}

function normalizeAnonymousBucket(ip: string, config: RuntimeConfig): string {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.');
    return createAnonymousBucketId(`${octets[0]}.${octets[1]}.${octets[2]}.0`, 'ipv4', config.lookupHmacKey);
  }

  if (net.isIPv6(normalized)) {
    const groups = normalized.split(':').slice(0, 4).join(':');
    return createAnonymousBucketId(`${groups}::`, 'ipv6', config.lookupHmacKey);
  }

  return createAnonymousBucketId('unknown', 'ipv4', config.lookupHmacKey);
}

function appendPrometheusMetric(lines: string[], name: string, type: 'gauge' | 'counter', value: number): void {
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(`${name} ${value}`);
}

export function createHttpRuntime({
  config,
  runtimeLogger,
  store,
  waiters,
  wakeBus,
}: HttpRuntimeDeps): HttpRuntime {
  const app = express();
  let initialized = false;
  let draining = false;

  app.set('trust proxy', config.trustProxy);
  app.use(express.text({ limit: '1mb', type: 'text/plain' }));

  const lookupIdForToken = (token: string): string => createLookupId(token, config.lookupHmacKey);

  const publishWakeTokens = async (tokens: string[]): Promise<void> => {
    await Promise.all(tokens.map((wakeToken) => wakeBus.publish({
      recipientLookupId: lookupIdForToken(wakeToken),
    })));
  };

  const consumeWake = async (recipientLookupId: string): Promise<void> => {
    if (!waiters.has(recipientLookupId)) {
      return;
    }

    const token = waiters.getToken(recipientLookupId);
    if (!token) {
      return;
    }

    const message = await store.consumeInboxMessage(token);
    if (!message) {
      return;
    }

    const resolved = waiters.resolveIfActive(recipientLookupId, message.text);
    if (resolved === 'resolved') {
      await store.clearWaiterOwner(token, config.instanceId);
      return;
    }

    await store.requeueInboxMessageFront(token, message);
    if (resolved === 'stale') {
      await store.clearWaiterOwner(token, config.instanceId);
    }
  };

  const enforceAnonymousRateLimit = async (
    req: Request,
    res: Response,
    scope: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> => {
    const bucket = normalizeAnonymousBucket(req.ip || 'unknown', config);
    const decision = await store.consumeRateLimit(
      scope,
      bucket,
      windowMs,
      config.nodeEnv === 'test' ? 1000 : max,
    );
    if (decision.allowed) {
      return true;
    }

    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    runtimeLogger.warn('rate_limit_hit', { scope });
    res.status(429).json({ error: 'Too many requests. Try again later.' });
    return false;
  };

  const enforceTokenRateLimit = async (
    req: Request,
    res: Response,
    scope: string,
    max: number,
    windowMs: number,
  ): Promise<string | null> => {
    const token = getToken(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }

    const decision = await store.consumeRateLimit(
      scope,
      token,
      windowMs,
      config.nodeEnv === 'test' ? 1000 : max,
    );
    if (decision.allowed) {
      return token;
    }

    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    runtimeLogger.warn('rate_limit_hit', { scope });
    res.status(429).json({ error: 'Too many requests. Try again later.' });
    return null;
  };

  const rejectDuringDrain = async (res: Response, globalOnly: boolean = false): Promise<boolean> => {
    if (!globalOnly && draining) {
      res.status(503).json({ error: 'Broker is draining. Try again later.' });
      return true;
    }

    if (await store.getDrainMode()) {
      res.status(503).json({ error: 'Broker is draining. Try again later.' });
      return true;
    }

    return false;
  };

  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!config.adminToken) {
      res.status(404).json({ error: 'Not found' });
      return false;
    }

    if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
      res.status(403).json({ error: 'Forbidden' });
      return false;
    }

    return true;
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/ready', async (_req, res) => {
    try {
      if (draining || await store.getDrainMode()) {
        res.status(503).json({ status: 'draining' });
        return;
      }

      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unready' });
    }
  });

  app.get('/metrics', async (_req, res) => {
    const metrics = await store.getMetricsSnapshot(waiters.size());
    const lines: string[] = [];
    appendPrometheusMetric(lines, 'a2a_active_sessions', 'gauge', metrics.activeSessions);
    appendPrometheusMetric(lines, 'a2a_waiting_sessions', 'gauge', metrics.waitingSessions);
    appendPrometheusMetric(lines, 'a2a_open_waiters', 'gauge', metrics.openWaiters);
    appendPrometheusMetric(lines, 'a2a_queued_inbox_messages', 'gauge', metrics.queuedInboxCount);
    appendPrometheusMetric(lines, 'a2a_sends_total', 'counter', metrics.sendsTotal);
    appendPrometheusMetric(lines, 'a2a_waits_total', 'counter', metrics.waitsTotal);
    appendPrometheusMetric(lines, 'a2a_rate_limit_hits_total', 'counter', metrics.rateLimitHitsTotal);
    appendPrometheusMetric(lines, 'a2a_drain_mode', 'gauge', metrics.drainMode ? 1 : 0);
    runtimeLogger.info('metrics_scraped', { activeSessions: metrics.activeSessions, waitingSessions: metrics.waitingSessions });
    res.type('text/plain').send(lines.join('\n'));
  });

  app.post('/register', async (req, res) => {
    if (await rejectDuringDrain(res, true)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'register', 10, 60 * 60 * 1000)) {
      return;
    }

    const token = await store.registerToken();
    runtimeLogger.info('token_registered');
    res.json({ token });
  });

  app.post('/setup', express.json({ limit: '1mb' }), async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'setup', 10, 60 * 60 * 1000)) {
      return;
    }

    const body = req.body as { type?: 'standard' | 'listener'; headless?: boolean };
    if (!body.type || (body.type !== 'standard' && body.type !== 'listener')) {
      res.status(400).json({ error: 'type (standard|listener) required' });
      return;
    }

    const result = await store.setupSession(body.type, !!body.headless);
    if (!result) {
      res.status(429).json({ error: 'Room limit reached (max 3)' });
      return;
    }

    runtimeLogger.info('session_created', { sessionType: body.type });
    res.json({ token: result.token, code: result.code, roomName: result.roomName, role: result.role });
  });

  app.post('/create', async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'create', 10, 60 * 60 * 1000)) {
      return;
    }

    const token = getToken(req);
    if (!token || !await store.isValidToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await store.createSession(token, 'standard');
    if (result === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result === 'already_paired') {
      res.status(400).json({ error: 'Already paired to a session' });
      return;
    }

    runtimeLogger.info('session_created', { sessionType: 'standard' });
    res.json({ inviteCode: result.code, roomName: result.roomName });
  });

  app.post('/listen', async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'listen', 10, 60 * 60 * 1000)) {
      return;
    }

    const token = getToken(req);
    if (!token || !await store.isValidToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await store.createSession(token, 'listener');
    if (result === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result === 'already_paired') {
      res.status(400).json({ error: 'Already paired to a session' });
      return;
    }

    runtimeLogger.info('session_created', { sessionType: 'listener' });
    res.json({ listenerCode: result.code, roomName: result.roomName });
  });

  app.post('/room-rule/headless', express.json({ limit: '1mb' }), async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    const token = await enforceTokenRateLimit(req, res, 'room_rule_headless', 30, 60 * 60 * 1000);
    if (!token) {
      return;
    }
    if (!await store.isValidToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body as { headless?: boolean };
    if (typeof body.headless !== 'boolean') {
      res.status(400).json({ error: 'headless (boolean) required' });
      return;
    }

    const result = await store.updateRoomHeadless(token, body.headless);
    if (result === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result === 'not_in_room') {
      res.status(400).json({ error: 'Not in a room' });
      return;
    }
    if (result === 'forbidden') {
      res.status(403).json({ error: 'Only the room creator can set room rules' });
      return;
    }

    runtimeLogger.info('room_rule_updated', { headless: body.headless });
    res.json({ ok: true });
  });

  app.post('/join/:inviteCode', async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'join', 20, 60 * 60 * 1000)) {
      return;
    }

    const token = getToken(req);
    if (!token || !await store.isValidToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const inviteCode = req.params['inviteCode'];
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code required' });
      return;
    }

    const result = await store.joinSession(token, inviteCode);
    if (result === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result === 'already_paired') {
      res.status(400).json({ error: 'Already paired to a session' });
      return;
    }
    if (result === 'invalid_code') {
      runtimeLogger.warn('join_attempt_rejected', { endpoint: 'join' });
      res.status(404).json({ error: 'Invite code invalid or already used' });
      return;
    }

    await publishWakeTokens(result.wakeTokens);
    runtimeLogger.info('session_joined', { role: result.role });
    res.json({
      roomName: result.roomName,
      role: result.role,
      headless: result.headless,
      rules: renderHttpWalkieTalkieRules(),
      status: result.wakeTokens.length > 0 ? '(2/2 connected)' : '(1/2 connected)',
    });
  });

  app.post('/register-and-join/:inviteCode', async (req, res) => {
    if (await rejectDuringDrain(res)) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'register_and_join', 20, 60 * 60 * 1000)) {
      return;
    }

    const inviteCode = req.params['inviteCode'];
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code required' });
      return;
    }

    const result = await store.registerAndJoin(inviteCode);
    if (result === 'invalid_code') {
      runtimeLogger.warn('join_attempt_rejected', { endpoint: 'register_and_join' });
      res.status(404).json({ error: 'Invite code invalid or already used' });
      return;
    }

    await publishWakeTokens(result.wakeTokens);
    runtimeLogger.info('session_joined', { role: result.role });
    res.json({
      token: result.token,
      roomName: result.roomName,
      role: result.role,
      headless: result.headless,
      rules: renderHttpWalkieTalkieRules(),
      status: result.wakeTokens.length > 0 ? '(2/2 connected)' : '(1/2 connected)',
    });
  });

  app.post('/send', async (req, res) => {
    const token = await enforceTokenRateLimit(req, res, 'send_token', 120, 60 * 1000);
    if (!token) {
      return;
    }
    if (!await enforceAnonymousRateLimit(req, res, 'send_bucket', 600, 60 * 1000)) {
      return;
    }

    if (!req.body || typeof req.body !== 'string') {
      res.status(400).json({ error: 'Message body required' });
      return;
    }

    const result = await store.sendMessage(token, req.body);
    if (result.kind === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result.kind === 'not_in_room') {
      res.status(400).json({ error: 'Not in a room' });
      return;
    }
    if (result.kind === 'partner_not_connected') {
      res.status(503).json({ error: 'Partner not connected' });
      return;
    }

    await publishWakeTokens(result.wakeTokens);
    if (result.kind === 'loop_paused') {
      runtimeLogger.warn('loop_detected', { endpoint: 'send' });
      res.status(429).send('SYSTEM: Repetitive messages detected. Session forcibly paused.');
      return;
    }

    res.send('DELIVERED');
  });

  app.get('/wait', async (req, res) => {
    if (draining) {
      res.status(503).json({ error: 'Broker is draining. Try again later.' });
      return;
    }

    const token = await enforceTokenRateLimit(req, res, 'wait', 120, 60 * 1000);
    if (!token) {
      return;
    }

    const touchResult = await store.touchParticipant(token);
    if (touchResult === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (touchResult === 'not_in_room') {
      res.status(400).json({ error: 'Not in a room' });
      return;
    }

    const queued = await store.consumeInbox(token);
    if (queued) {
      res.send(queued);
      return;
    }

    const waiterLookupId = lookupIdForToken(token);
    const timer = setTimeout(async () => {
      waiters.clear(waiterLookupId);
      await store.clearWaiterOwner(token, config.instanceId);
      res.send(`TIMEOUT: No event received within ${Math.floor(config.waitTimeoutMs / 1000)}s`);
    }, config.waitTimeoutMs);
    timer.unref();

    if (!waiters.register(waiterLookupId, { token, res, timer })) {
      clearTimeout(timer);
      runtimeLogger.warn('wait_rejected', { reason: 'already_pending' });
      res.status(409).json({ error: 'Wait already pending' });
      return;
    }

    await store.incrementWaits();
    await store.registerWaiterOwner(token, config.instanceId, config.waiterTtlMs);

    req.on('close', () => {
      waiters.clear(waiterLookupId);
      void store.clearWaiterOwner(token, config.instanceId);
    });

    await consumeWake(waiterLookupId);
  });

  app.post('/leave', async (req, res) => {
    const token = getToken(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await store.leaveSession(token);
    if (result.kind === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result.kind === 'not_in_room') {
      res.status(400).json({ error: 'Not in a room' });
      return;
    }

    await publishWakeTokens(result.wakeTokens);
    runtimeLogger.info('session_closed', { reason: 'explicit_leave' });
    res.json({ ok: true });
  });

  app.get('/ping', async (req, res) => {
    const token = await enforceTokenRateLimit(req, res, 'ping', 60, 60 * 1000);
    if (!token) {
      return;
    }

    const result = await store.ping(token);
    if (result.kind === 'unauthorized') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (result.kind === 'not_in_room') {
      res.status(400).json({ error: 'Not in a room' });
      return;
    }

    res.json({
      room_alive: true,
      partner_connected: result.partnerConnected,
      partner_last_seen_ms: result.partnerLastSeenMs,
    });
  });

  app.post('/admin/drain', express.json({ limit: '1mb' }), async (req, res) => {
    if (!requireAdmin(req, res)) {
      return;
    }
    const body = req.body as { enabled?: boolean };
    await store.setDrainMode(body.enabled !== false);
    runtimeLogger.info('drain_started', { enabled: body.enabled !== false });
    res.json({ ok: true });
  });

  app.post('/admin/invalidate', express.json({ limit: '1mb' }), async (req, res) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    const body = req.body as { token?: string; code?: string; roomName?: string };
    const provided = [body.token, body.code, body.roomName].filter((value) => typeof value === 'string');
    if (provided.length !== 1) {
      res.status(400).json({ error: 'Exactly one invalidation target is required' });
      return;
    }

    const result = body.token
      ? await store.invalidateByToken(body.token)
      : body.code
        ? await store.invalidateByCode(body.code)
        : await store.invalidateByRoomName(body.roomName as string);

    if (!result.ok) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    await publishWakeTokens(result.wakeTokens);
    runtimeLogger.info('admin_invalidate', { targetType: body.token ? 'token' : body.code ? 'code' : 'room' });
    res.json({ ok: true });
  });

  return {
    app,
    async initialize(): Promise<void> {
      if (initialized) {
        return;
      }

      await wakeBus.start(async (event) => {
        await consumeWake(event.recipientLookupId);
      });
      initialized = true;
    },
    async beginDrain(): Promise<void> {
      if (draining) {
        return;
      }

      draining = true;
      runtimeLogger.info('drain_started', { local: true });
      const drainedTokens = waiters.resolveAll(renderDrainMessage());
      await Promise.all(drainedTokens.map((token) => store.clearWaiterOwner(token, config.instanceId)));
      runtimeLogger.info('drain_completed', { drainedWaiters: drainedTokens.length });
    },
    async close(): Promise<void> {
      await Promise.allSettled([wakeBus.close(), store.close()]);
    },
    isDraining(): boolean {
      return draining;
    },
  };
}

function createDefaultTestRuntime(): HttpRuntime {
  const config = createRuntimeConfig({
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    BROKER_STORE: 'memory',
    LOOKUP_HMAC_KEY: process.env.LOOKUP_HMAC_KEY ?? 'x'.repeat(32),
  });
  return createHttpRuntime({
    config,
    runtimeLogger: logger,
    store: new MemoryBrokerStore(config),
    waiters: new WaiterRegistry(),
    wakeBus: new MemoryWakeBus(),
  });
}

const defaultRuntime = createDefaultTestRuntime();
void defaultRuntime.initialize();

export const app = defaultRuntime.app;

export async function startHttpServer(runtime: HttpRuntime, config: RuntimeConfig, runtimeLogger: PrivacyLogger): Promise<http.Server | https.Server | null> {
  await runtime.initialize();
  const serverApp = runtime.app;

  if (config.httpsKeyPath && config.httpsCertPath) {
    try {
      const key = fs.readFileSync(config.httpsKeyPath);
      const cert = fs.readFileSync(config.httpsCertPath);
      return await new Promise<https.Server>((resolve) => {
        const server = https.createServer({ key, cert }, serverApp).listen(config.httpPort, config.httpBindHost, () => {
          runtimeLogger.info('http_server_started', { https: true, port: config.httpPort, bindHost: config.httpBindHost });
          resolve(server);
        });
      });
    } catch (error) {
      runtimeLogger.warn('https_cert_missing', { https: true });
      if (error instanceof Error) {
        runtimeLogger.warn('https_startup_detail', { detailLength: error.message.length });
      }
      if (!config.allowInsecureHttpLocalDev) {
        runtimeLogger.error('broker_startup_failed', { component: 'http' });
        return null;
      }
    }
  }

  return await new Promise<http.Server>((resolve) => {
    const server = http.createServer(serverApp).listen(config.httpPort, config.httpBindHost, () => {
      runtimeLogger.info('http_server_started', { https: false, port: config.httpPort, bindHost: config.httpBindHost });
      resolve(server);
    });
  });
}
