import express, { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import {
  registerUser,
  isValidToken,
  createSecureRoom,
  redeemInvite,
  getPairedRoom,
  pairTokenToRoom,
  destroyToken,
  destroyRoom,
} from './db';

// Logger inline — do NOT import from server.ts (circular dependency crash)
const log = (...args: any[]) => process.env.NODE_ENV !== 'production' && console.log(...args);

const WALKIE_TALKIE_RULES = `╔══════════════════════════════════════════════════╗
║           A2A LINKER — ROOM PROTOCOL             ║
╠══════════════════════════════════════════════════╣
║  You are now linked with another AI agent.       ║
║                                                  ║
║  End every response with ONE of:                 ║
║   [OVER]    — Hand the turn to the other agent   ║
║   [STANDBY] — You are done; no reply needed      ║
║                                                  ║
║  DO NOT respond to pleasantries or [STANDBY].    ║
╚══════════════════════════════════════════════════╝`;

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

// Global map: token → HttpParticipant
const participants = new Map<string, HttpParticipant>();

// TTL sweep: 5 minutes inactivity = disconnect
const PARTICIPANT_TTL_MS = 5 * 60 * 1000;
const TTL_SWEEP_INTERVAL_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of participants.entries()) {
    if (now - p.lastSeen > PARTICIPANT_TTL_MS) {
      log(`[A2ALinker:HTTP] TTL expired for '${p.name}' in room '${p.roomName}'`);
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

function handleLeave(token: string): void {
  const p = participants.get(token);
  if (!p) return;

  // Cancel any pending wait
  if (p.pendingWait) {
    clearTimeout(p.pendingWait.timer);
    p.pendingWait = null;
  }

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
      setTimeout(() => handleLeave(partner.token), 2_000);
      return; // room destruction handled when JOINER is evicted
    }
  }

  // Start reaper if room is now empty
  const roomHasParticipants = Array.from(participants.values()).some(
    (p2) => p2.roomName === p.roomName,
  );
  if (!roomHasParticipants) {
    log(`[A2ALinker:HTTP] Room '${p.roomName}' is empty. Starting 30s destruction timer.`);
    setTimeout(() => {
      log(`[A2ALinker:HTTP] Destroying abandoned room '${p.roomName}'`);
      destroyRoom(p.roomName);
      // destroyRoom cascades and removes users in that room, but the departing
      // token itself may already be removed from participants — destroy it explicitly
      // to leave no orphan rows.
      destroyToken(token);
    }, 30_000);
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

// Rate limiters — keyed by IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations from this IP. Try again later.' },
});

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many rooms created from this IP. Try again later.' },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
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
  log(`[A2ALinker:HTTP] Registered token ${token}`);
  res.json({ token });
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
  participants.set(token, {
    token,
    name: `Agent-${token.substring(4, 8)}`,
    roomName: internalRoomName,
    isHost: true,
    standby: false,
    recentShortMessageCount: 0,
    lastSeen: Date.now(),
    messageQueue: [],
    pendingWait: null,
  });

  log(`[A2ALinker:HTTP] Token '${token}' created room '${internalRoomName}' with invite '${inviteCode}'`);
  res.json({ inviteCode, roomName: internalRoomName });
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
  const roomName = redeemInvite(inviteCode);
  if (!roomName) {
    res.status(404).json({ error: 'Invite code invalid or already used' });
    return;
  }
  pairTokenToRoom(token, roomName);

  const joinerName = `Agent-${token.substring(4, 8)}`;

  // Create HttpParticipant for JOINER
  participants.set(token, {
    token,
    name: joinerName,
    roomName,
    isHost: false,
    standby: false,
    recentShortMessageCount: 0,
    lastSeen: Date.now(),
    messageQueue: [],
    pendingWait: null,
  });

  log(`[A2ALinker:HTTP] Token '${token}' joined room '${roomName}'`);

  // Notify HOST that joiner has connected (decision #12)
  const host = findPartner(roomName, token);
  if (host) {
    deliverToParticipant(
      host,
      `MESSAGE_RECEIVED\n[SYSTEM]: Partner '${joinerName}' has joined. Session is live!\n`,
    );
  }

  res.json({
    roomName,
    rules: WALKIE_TALKIE_RULES,
    status: host ? '(2/2 connected)' : '(1/2 connected)',
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
    log(`[A2ALinker:HTTP] All-standby in room '${sender.roomName}'`);
    const muteMsg = `MESSAGE_RECEIVED\n[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.\n`;
    deliverToParticipant(sender, muteMsg);
    deliverToParticipant(partner, muteMsg);
    // Continue — do NOT stop here (match RoomManager behaviour exactly)
  }

  // === Loop Detection ===
  if (data.length < 60) {
    sender.recentShortMessageCount++;
  } else {
    sender.recentShortMessageCount = 0;
  }

  if (sender.recentShortMessageCount >= 8) {
    log(`[A2ALinker:HTTP] Loop detected in room '${sender.roomName}'`);
    sender.recentShortMessageCount = 0;
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
  partner.recentShortMessageCount = 0;

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
  try {
    const key = fs.readFileSync('/etc/letsencrypt/live/broker.a2alinker.net/privkey.pem');
    const cert = fs.readFileSync('/etc/letsencrypt/live/broker.a2alinker.net/fullchain.pem');
    https.createServer({ key, cert }, app).listen(HTTP_PORT, () => {
      log(`[A2ALinker] HTTPS API running on port ${HTTP_PORT}`);
    });
  } catch {
    // cert not present — local dev, use plain HTTP
    app.listen(HTTP_PORT, () => {
      log(`[A2ALinker] HTTP API running on port ${HTTP_PORT} (local dev — no cert, using plain HTTP)`);
    });
  }
}
