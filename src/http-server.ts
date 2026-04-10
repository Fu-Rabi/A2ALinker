import express, { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { resolveHttpsCertPaths } from './https-config';
import { logger } from './logger';
import { resetLoopCounter, trackOutgoingMessage } from './loop-detection';
import { renderHttpWalkieTalkieRules } from './protocol';
import {
  registerUser,
  isValidToken,
  createSecureRoom,
  createListenerRoom,
  redeemInvite,
  getPairedRoom,
  pairTokenToRoom,
  destroyToken,
  destroyRoom,
  setRoomHeadless,
  getRoomHeadless,
  getRoomCreatorToken,
  setupUserAndRoom,
  registerAndJoin,
} from './db';

const WALKIE_TALKIE_RULES = renderHttpWalkieTalkieRules();

interface QueuedMessage {
  text: string; // complete ready-to-send string, prefixed with MESSAGE_RECEIVED\n
}

interface HttpParticipant {
  token: string;
  name: string;                 // "Agent-xxxx" (token.substring(4, 8))
  roomName: string;
  isHost: boolean;              // true = created the room, owns session lifecycle
  standby: boolean;
  recentShortMessageCount: number;
  lastSeen: number;             // Date.now() — updated on every /send or /wait call
  messageQueue: QueuedMessage[];
  pendingWait: {
    res: Response;
    timer: NodeJS.Timeout;
  } | null;
}

function detachTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}

// Global map: token → HttpParticipant
const participants = new Map<string, HttpParticipant>();

// TTL sweep: 30 minutes inactivity = disconnect (increased for complex AI tasks)
const PARTICIPANT_TTL_MS = 30 * 60 * 1000;
const TTL_SWEEP_INTERVAL_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of participants.entries()) {
    if (now - p.lastSeen > PARTICIPANT_TTL_MS) {
      logger.info(`[A2ALinker:HTTP] TTL expired for '${p.name}' in room '${p.roomName}'`);
      handleLeave(token);
    }
  }
}, TTL_SWEEP_INTERVAL_MS).unref(); // unref so interval doesn't prevent process exit

function findPartner(roomName: string, senderToken: string): HttpParticipant | undefined {
  for (const p of participants.values()) {
    if (p.roomName === roomName && p.token !== senderToken) return p;
  }
  return undefined;
}

function deliverToParticipant(p: HttpParticipant, text: string): void {
  if (p.pendingWait) {
    const { res, timer } = p.pendingWait;
    clearTimeout(timer);
    p.pendingWait = null;
    res.send(text);
  } else {
    p.messageQueue.push({ text });
  }
}

function resolveParticipantWait(p: HttpParticipant, text: string): void {
  if (!p.pendingWait) {
    return;
  }
  const { res, timer } = p.pendingWait;
  clearTimeout(timer);
  p.pendingWait = null;
  res.send(text);
}

function buildSelfLeaveMessage(p: HttpParticipant, forcedByHost: boolean): string {
  if (forcedByHost && !p.isHost) {
    return 'MESSAGE_RECEIVED\n[SYSTEM]: HOST has closed the session. You are disconnected.\n';
  }
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Session ended. You are disconnected.\n';
}

function handleLeave(token: string, forcedByHost: boolean = false): void {
  const p = participants.get(token);
  if (!p) return;

  resolveParticipantWait(p, buildSelfLeaveMessage(p, forcedByHost));

  const partner = findPartner(p.roomName, token);
  participants.delete(token);

  // Notify partner with role-aware message
  if (partner) {
    const msg = p.isHost
      ? `MESSAGE_RECEIVED\n[SYSTEM]: HOST has closed the session. You are disconnected.\n`
      : `MESSAGE_RECEIVED\n[SYSTEM]: '${p.name}' has left the room. Session ended.\n`;
    deliverToParticipant(partner, msg);

    // HOST leaving forces JOINER out too — give them 2s to read the message
    if (p.isHost) {
      detachTimer(setTimeout(() => handleLeave(partner.token, true), 2_000));
      return; // room destruction handled when JOINER is evicted
    }
  }

  // Start reaper if room is now empty
  const roomHasParticipants = Array.from(participants.values()).some(
    (p2) => p2.roomName === p.roomName,
  );
  if (!roomHasParticipants) {
    logger.info(`[A2ALinker:HTTP] Room '${p.roomName}' is empty. Starting 30s destruction timer.`);
    detachTimer(setTimeout(() => {
      logger.info(`[A2ALinker:HTTP] Destroying abandoned room '${p.roomName}'`);
      destroyRoom(p.roomName);
      // destroyRoom cascades and removes users in that room, but the departing
      // token itself may already be removed from participants — destroy it explicitly
      // to leave no orphan rows.
      destroyToken(token);
    }, 30_000));
  } else {
    // Room still has other participants — this token is departing and no longer
    // paired. Destroy it immediately so it doesn't linger in the DB.
    destroyToken(token);
  }
}

function getToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

const app = express();
app.use(express.text({ limit: '1mb' }));

// Rate limiters — keyed by IP. Limits are relaxed in test mode (DB_PATH=:memory:).
const isTestMode = process.env['DB_PATH'] === ':memory:';

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTestMode ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations from this IP. Try again later.' },
});

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTestMode ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many rooms created from this IP. Try again later.' },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTestMode ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many join attempts from this IP. Try again later.' },
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// POST /register
app.post('/register', registerLimiter, (_req, res) => {
  const token = 'tok_' + crypto.randomBytes(6).toString('hex');
  registerUser(token);
  logger.info(`[A2ALinker:HTTP] Registered token ${token}`);
  res.json({ token });
});

// POST /setup — one-shot registration + room creation
app.post('/setup', createLimiter, express.json({ limit: '1mb' }), (req, res) => {
  const body = req.body as { type: 'standard' | 'listener', headless?: boolean };
  if (!body.type || (body.type !== 'standard' && body.type !== 'listener')) {
    res.status(400).json({ error: 'type (standard|listener) required' });
    return;
  }

  const result = setupUserAndRoom(body.type, !!body.headless);
  if (!result) {
    res.status(429).json({ error: 'Room limit reached (max 3)' });
    return;
  }

  const { token, code, roomName } = result;

  // Create HttpParticipant for the creator
  participants.set(token, createHttpParticipant(token, roomName, body.type === 'standard'));

  logger.info(`[A2ALinker:HTTP] One-shot setup: token '${token}' created ${body.type} room '${roomName}' with code '${code}'`);
  res.json({ token, code, roomName, role: body.type === 'standard' ? 'host' : 'joiner' });
});

// POST /create
app.post('/create', createLimiter, (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (getPairedRoom(token)) {
    res.status(400).json({ error: 'Already paired to a session' });
    return;
  }
  const result = createSecureRoom(token);
  if (!result) {
    res.status(429).json({ error: 'Room limit reached (max 3)' });
    return;
  }
  const { inviteCode, internalRoomName } = result;
  pairTokenToRoom(token, internalRoomName);

  // Create HttpParticipant for HOST
  participants.set(token, createHttpParticipant(token, internalRoomName, true));

  logger.info(`[A2ALinker:HTTP] Token '${token}' created room '${internalRoomName}' with invite '${inviteCode}'`);
  res.json({ inviteCode, roomName: internalRoomName });
});

// POST /listen — JOINER pre-stages a room. Redeemer of the listen_ code becomes HOST.
app.post('/listen', createLimiter, (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (getPairedRoom(token)) {
    res.status(400).json({ error: 'Already paired to a session' });
    return;
  }
  const result = createListenerRoom(token);
  if (!result) {
    res.status(429).json({ error: 'Room limit reached (max 3)' });
    return;
  }
  const { listenerCode, internalRoomName } = result;
  pairTokenToRoom(token, internalRoomName);

  // Creator waits as JOINER — redeemer of the listen_ code becomes HOST
  participants.set(token, createHttpParticipant(token, internalRoomName, false));

  logger.info(`[A2ALinker:HTTP] Token '${token}' created listener room '${internalRoomName}' with code '${listenerCode}'`);
  res.json({ listenerCode, roomName: internalRoomName });
});

// POST /room-rule/headless — HOST sets autonomous mode room rule
app.post('/room-rule/headless', createLimiter, express.json({ limit: '1mb' }), (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const participant = participants.get(token);
  if (!participant) {
    res.status(400).json({ error: 'Not in a room' });
    return;
  }
  const creatorToken = getRoomCreatorToken(participant.roomName);
  if (creatorToken !== token) {
    res.status(403).json({ error: 'Only the room creator can set room rules' });
    return;
  }
  const body = req.body as { headless?: boolean };
  if (typeof body.headless !== 'boolean') {
    res.status(400).json({ error: 'headless (boolean) required' });
    return;
  }
  setRoomHeadless(participant.roomName, body.headless);
  logger.info(`[A2ALinker:HTTP] Room '${participant.roomName}' headless rule set to ${body.headless}`);
  res.json({ ok: true });
});

// POST /join/:inviteCode
app.post('/join/:inviteCode', joinLimiter, (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (getPairedRoom(token)) {
    res.status(400).json({ error: 'Already paired to a session' });
    return;
  }
  const inviteCode = req.params['inviteCode'];
  if (!inviteCode) {
    res.status(400).json({ error: 'Invite code required' });
    return;
  }
  const redeemResult = redeemInvite(inviteCode);
  if (!redeemResult) {
    res.status(404).json({ error: 'Invite code invalid or already used' });
    return;
  }
  const { roomName, codeType } = redeemResult;
  const redeemerIsHost = codeType === 'listener'; // listener code redeemer becomes HOST
  const headless = getRoomHeadless(roomName);

  pairTokenToRoom(token, roomName);

  const joinerName = `Agent-${token.substring(4, 8)}`;

  // Create HttpParticipant — role determined by code type
  participants.set(token, createHttpParticipant(token, roomName, redeemerIsHost));

  logger.info(`[A2ALinker:HTTP] Token '${token}' joined room '${roomName}' as ${redeemerIsHost ? 'HOST' : 'JOINER'}`);

  // Notify the waiting participant that their partner has connected
  const partner = findPartner(roomName, token);
  if (partner) {
    const msg = redeemerIsHost
      ? `MESSAGE_RECEIVED\n[SYSTEM]: HOST '${joinerName}' has joined. Session is live!\n`
      : `MESSAGE_RECEIVED\n[SYSTEM]: Partner '${joinerName}' has joined. Session is live!\n`;
    deliverToParticipant(partner, msg);
  }

  res.json({
    roomName,
    role: redeemerIsHost ? 'host' : 'joiner',
    headless,
    rules: WALKIE_TALKIE_RULES,
    status: partner ? '(2/2 connected)' : '(1/2 connected)',
  });
});

// POST /register-and-join/:inviteCode — one-shot registration + join
app.post('/register-and-join/:inviteCode', joinLimiter, (req, res) => {
  const inviteCode = req.params['inviteCode'];
  if (!inviteCode) {
    res.status(400).json({ error: 'Invite code required' });
    return;
  }

  // Atomic: burn invite, register user, pair token — all or nothing
  const result = registerAndJoin(inviteCode);
  if (!result) {
    res.status(404).json({ error: 'Invite code invalid or already used' });
    return;
  }

  const { token, roomName, codeType, headless } = result;
  const redeemerIsHost = codeType === 'listener';

  const joinerName = `Agent-${token.substring(4, 8)}`;
  participants.set(token, createHttpParticipant(token, roomName, redeemerIsHost));

  const partner = findPartner(roomName, token);
  if (partner) {
    const msg = redeemerIsHost
      ? `MESSAGE_RECEIVED\n[SYSTEM]: HOST '${joinerName}' has joined. Session is live!\n`
      : `MESSAGE_RECEIVED\n[SYSTEM]: Partner '${joinerName}' has joined. Session is live!\n`;
    deliverToParticipant(partner, msg);
  }

  logger.info(`[A2ALinker:HTTP] One-shot register-and-join: token '${token}' joined room '${roomName}'`);
  res.json({
    token,
    roomName,
    role: redeemerIsHost ? 'host' : 'joiner',
    headless,
    rules: WALKIE_TALKIE_RULES,
    status: partner ? '(2/2 connected)' : '(1/2 connected)',
  });
});

// POST /send
app.post('/send', (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const sender = participants.get(token);
  if (!sender) {
    res.status(400).json({ error: 'Not in a room' });
    return;
  }
  sender.lastSeen = Date.now();

  const rawBody = req.body as string;
  if (!rawBody || typeof rawBody !== 'string') {
    res.status(400).json({ error: 'Message body required' });
    return;
  }

  const partner = findPartner(sender.roomName, token);
  if (!partner) {
    res.status(503).json({ error: 'Partner not connected' });
    return;
  }

  // === [OVER] / [STANDBY] Protocol ===
  let data = rawBody;
  let signaled: 'OVER' | 'STANDBY' | null = null;

  if (data.match(/\[STANDBY\]/i)) {
    signaled = 'STANDBY';
    data = data.replace(/\[STANDBY\]/gi, '').trim();
    sender.standby = true;
  } else if (data.match(/\[OVER\]/i)) {
    signaled = 'OVER';
    data = data.replace(/\[OVER\]/gi, '').trim();
    sender.standby = false;
  } else {
    sender.standby = false;
  }

  // Check all-standby — broadcast mute to both, then continue delivery
  if (sender.standby && partner.standby) {
    logger.info(`[A2ALinker:HTTP] All-standby in room '${sender.roomName}'`);
    const muteMsg = `MESSAGE_RECEIVED\n[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.\n`;
    deliverToParticipant(sender, muteMsg);
    deliverToParticipant(partner, muteMsg);
    // Continue — do NOT stop here (match RoomManager behaviour exactly)
  }

  // === Loop Detection ===
  if (trackOutgoingMessage(sender, data.length)) {
    logger.info(`[A2ALinker:HTTP] Loop detected in room '${sender.roomName}'`);
    resetLoopCounter(sender);
    sender.standby = true;
    partner.standby = true;
    const alertMsg = `MESSAGE_RECEIVED\n[SYSTEM ALERT]: Repetitive short messages detected. Conversation forcibly paused. Human intervention required.\n`;
    deliverToParticipant(sender, alertMsg);
    deliverToParticipant(partner, alertMsg);
    res.status(429).send('SYSTEM: Repetitive messages detected. Session forcibly paused.');
    return;
  }

  // Format message box
  const signalBadge = signaled === 'OVER' ? ' [OVER]' : signaled === 'STANDBY' ? ' [STANDBY]' : '';
  const lines = data.split('\n').map((l) => `│ ${l}`).join('\n');
  const messageText = `MESSAGE_RECEIVED\n┌─ ${sender.name}${signalBadge}\n│\n${lines}\n└────\n`;

  // Deliver to partner; receiving a message resets their short-message counter
  deliverToParticipant(partner, messageText);
  resetLoopCounter(partner);

  res.send('DELIVERED');
});

// GET /wait
app.get('/wait', (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const participant = participants.get(token);
  if (!participant) {
    res.status(400).json({ error: 'Not in a room' });
    return;
  }
  participant.lastSeen = Date.now();

  // Return queued message immediately if available
  if (participant.messageQueue.length > 0) {
    const msg = participant.messageQueue.shift();
    if (msg) {
      res.send(msg.text);
      return;
    }
  }

  // Hold connection open until message arrives or timeout
  const timer = setTimeout(() => {
    participant.pendingWait = null;
    res.send('TIMEOUT: No event received within 110s');
  }, 110_000);

  participant.pendingWait = { res, timer };

  // Detect client disconnect — clear pending state, do NOT call leaveRoom
  req.on('close', () => {
    if (participant.pendingWait) {
      clearTimeout(participant.pendingWait.timer);
      participant.pendingWait = null;
    }
  });
});

// POST /leave
app.post('/leave', (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  handleLeave(token);
  res.json({ ok: true });
});

// GET /ping
app.get('/ping', (req, res) => {
  const token = getToken(req);
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const participant = participants.get(token);
  if (!participant) {
    // Not in a room — session was closed
    res.status(400).json({ error: 'Not in a room' });
    return;
  }
  const partner = findPartner(participant.roomName, token);
  res.json({
    room_alive: true,
    partner_connected: !!partner,
    partner_last_seen_ms: partner ? Date.now() - partner.lastSeen : null,
  });
});

export { app };

export function startHttpServer(): void {
  const HTTP_PORT = parseInt(process.env.HTTP_PORT || '443', 10);
  const { keyPath, certPath } = resolveHttpsCertPaths();

  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    https.createServer({ key, cert }, app).listen(HTTP_PORT, () => {
      logger.info(`[A2ALinker] HTTPS API running on port ${HTTP_PORT}`);
    });
  } catch (error) {
    logger.warn(
      `[A2ALinker] HTTPS certs unavailable at '${keyPath}' and '${certPath}'. Falling back to HTTP.`,
    );
    if (error instanceof Error) {
      logger.warn(`[A2ALinker] HTTPS startup detail: ${error.message}`);
    }
    // cert not present — local dev, use plain HTTP
    app.listen(HTTP_PORT, () => {
      logger.info(`[A2ALinker] HTTP API running on port ${HTTP_PORT} (local dev — no cert, using plain HTTP)`);
    });
  }
}

function createHttpParticipant(token: string, roomName: string, isHost: boolean): HttpParticipant {
  return {
    token,
    name: `Agent-${token.substring(4, 8)}`,
    roomName,
    isHost,
    standby: false,
    recentShortMessageCount: 0,
    lastSeen: Date.now(),
    messageQueue: [],
    pendingWait: null,
  };
}
