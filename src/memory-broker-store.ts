import {
  BrokerMetricsSnapshot,
  BrokerStore,
  HeadlessUpdateStatus,
  InvalidationResult,
  JoinSessionResult,
  LeaveSessionResult,
  PingResult,
  RateLimitDecision,
  RegisterAndJoinResult,
  SendMessageResult,
  SessionRole,
  SessionSetupResult,
  SessionType,
  TouchParticipantResult,
} from './broker-store';
import { RuntimeConfig } from './config';
import { LOOP_DETECTION_THRESHOLD, SHORT_MESSAGE_BYTES } from './loop-detection';
import { generateSecret } from './runtime-ids';
import {
  formatDeliveredMessage,
  renderAdminClosedMessage,
  renderAllStandbyMessage,
  renderHostClosedMessage,
  renderJoinMessage,
  renderLoopDetectedMessage,
  renderPartnerLeftMessage,
  renderSessionExpiredMessage,
} from './broker-messages';

interface TokenRecord {
  roomName: string | null;
  role: SessionRole | null;
  standby: boolean;
  recentShortMessageCount: number;
  lastSeen: number;
  createdAt: number;
  pendingCloseMessages: number;
}

interface RoomRecord {
  roomName: string;
  creatorToken: string;
  headless: boolean;
  hostToken: string | null;
  joinerToken: string | null;
  createdAt: number;
}

interface CodeRecord {
  roomName: string;
  codeType: 'invite' | 'listener';
  expiresAt: number;
}

interface InboxMessage {
  text: string;
  closeAfterDelivery: boolean;
  expiresAt: number;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export class MemoryBrokerStore implements BrokerStore {
  public readonly config: RuntimeConfig;
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly inboxes = new Map<string, InboxMessage[]>();
  private readonly waiterOwners = new Map<string, { instanceId: string; expiresAt: number }>();
  private readonly rateLimits = new Map<string, RateLimitRecord>();
  private sendsTotal = 0;
  private waitsTotal = 0;
  private rateLimitHitsTotal = 0;
  private drainMode = false;

  public constructor(config: RuntimeConfig) {
    this.config = config;
  }

  public async registerToken(): Promise<string> {
    this.cleanupExpired();
    const token = generateSecret('tok_');
    this.tokens.set(token, {
      roomName: null,
      role: null,
      standby: false,
      recentShortMessageCount: 0,
      lastSeen: Date.now(),
      createdAt: Date.now(),
      pendingCloseMessages: 0,
    });
    return token;
  }

  public async isValidToken(token: string): Promise<boolean> {
    this.cleanupExpired();
    return this.tokens.has(token);
  }

  public async setupSession(type: SessionType, headless: boolean): Promise<SessionSetupResult | null> {
    this.cleanupExpired();
    const token = await this.registerToken();
    const roomName = generateSecret('room_');
    const code = generateSecret(type === 'standard' ? 'invite_' : 'listen_');
    const role: SessionRole = type === 'standard' ? 'host' : 'joiner';
    const room: RoomRecord = {
      roomName,
      creatorToken: token,
      headless,
      hostToken: role === 'host' ? token : null,
      joinerToken: role === 'joiner' ? token : null,
      createdAt: Date.now(),
    };
    this.rooms.set(roomName, room);
    this.codes.set(code, {
      roomName,
      codeType: type === 'standard' ? 'invite' : 'listener',
      expiresAt: Date.now() + this.config.codeTtlMs,
    });
    this.pairToken(token, roomName, role);
    return { token, code, roomName, role };
  }

  public async createSession(
    token: string,
    type: SessionType,
  ): Promise<{ code: string; roomName: string } | 'unauthorized' | 'already_paired'> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (tokenRecord.roomName) {
      return 'already_paired';
    }

    const roomName = generateSecret('room_');
    const code = generateSecret(type === 'standard' ? 'invite_' : 'listen_');
    const role: SessionRole = type === 'standard' ? 'host' : 'joiner';
    this.rooms.set(roomName, {
      roomName,
      creatorToken: token,
      headless: false,
      hostToken: role === 'host' ? token : null,
      joinerToken: role === 'joiner' ? token : null,
      createdAt: Date.now(),
    });
    this.codes.set(code, {
      roomName,
      codeType: type === 'standard' ? 'invite' : 'listener',
      expiresAt: Date.now() + this.config.codeTtlMs,
    });
    this.pairToken(token, roomName, role);
    return { code, roomName };
  }

  public async joinSession(
    token: string,
    code: string,
  ): Promise<JoinSessionResult | 'unauthorized' | 'already_paired' | 'invalid_code'> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (tokenRecord.roomName) {
      return 'already_paired';
    }

    const codeRecord = this.codes.get(code);
    if (!codeRecord || codeRecord.expiresAt <= Date.now()) {
      this.codes.delete(code);
      return 'invalid_code';
    }

    const room = this.rooms.get(codeRecord.roomName);
    if (!room) {
      this.codes.delete(code);
      return 'invalid_code';
    }

    const role: SessionRole = codeRecord.codeType === 'listener' ? 'host' : 'joiner';
    this.codes.delete(code);
    this.pairToken(token, room.roomName, role);
    if (role === 'host') {
      room.hostToken = token;
    } else {
      room.joinerToken = token;
    }

    const partnerToken = role === 'host' ? room.joinerToken : room.hostToken;
    const wakeTokens: string[] = [];
    if (partnerToken) {
      this.pushInbox(partnerToken, renderJoinMessage(token, role === 'host'));
      wakeTokens.push(partnerToken);
    }

    return {
      roomName: room.roomName,
      role,
      headless: room.headless,
      wakeTokens,
    };
  }

  public async registerAndJoin(code: string): Promise<RegisterAndJoinResult | 'invalid_code'> {
    this.cleanupExpired();
    const token = await this.registerToken();
    const result = await this.joinSession(token, code);
    if (result === 'invalid_code') {
      this.tokens.delete(token);
      return 'invalid_code';
    }
    if (typeof result === 'string') {
      throw new Error(`Unexpected registerAndJoin result '${result}'`);
    }
    return { token, ...result };
  }

  public async updateRoomHeadless(token: string, headless: boolean): Promise<HeadlessUpdateStatus> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (!tokenRecord.roomName) {
      return 'not_in_room';
    }

    const room = this.rooms.get(tokenRecord.roomName);
    if (!room) {
      return 'not_in_room';
    }
    if (room.creatorToken !== token) {
      return 'forbidden';
    }

    room.headless = headless;
    tokenRecord.lastSeen = Date.now();
    return 'ok';
  }

  public async sendMessage(token: string, body: string): Promise<SendMessageResult> {
    this.cleanupExpired();
    const sender = this.tokens.get(token);
    if (!sender) {
      return { kind: 'unauthorized' };
    }
    if (!sender.roomName || !sender.role) {
      return { kind: 'not_in_room' };
    }

    const room = this.rooms.get(sender.roomName);
    if (!room) {
      return { kind: 'not_in_room' };
    }

    sender.lastSeen = Date.now();
    const partnerToken = sender.role === 'host' ? room.joinerToken : room.hostToken;
    if (!partnerToken) {
      return { kind: 'partner_not_connected' };
    }
    const partner = this.tokens.get(partnerToken);
    if (!partner) {
      return { kind: 'partner_not_connected' };
    }

    let data = body;
    let signaled: 'OVER' | 'STANDBY' | null = null;

    if (/\[STANDBY\]/i.test(data)) {
      signaled = 'STANDBY';
      data = data.replace(/\[STANDBY\]/gi, '').trim();
      sender.standby = true;
    } else if (/\[OVER\]/i.test(data)) {
      signaled = 'OVER';
      data = data.replace(/\[OVER\]/gi, '').trim();
      sender.standby = false;
    } else {
      sender.standby = false;
    }

    const wakeTokens = new Set<string>();

    if (sender.standby && partner.standby) {
      this.pushInbox(token, renderAllStandbyMessage());
      this.pushInbox(partnerToken, renderAllStandbyMessage());
      wakeTokens.add(token);
      wakeTokens.add(partnerToken);
    }

    if (data.length < SHORT_MESSAGE_BYTES) {
      sender.recentShortMessageCount += 1;
    } else {
      sender.recentShortMessageCount = 0;
    }

    if (sender.recentShortMessageCount >= LOOP_DETECTION_THRESHOLD) {
      sender.recentShortMessageCount = 0;
      sender.standby = true;
      partner.standby = true;
      this.pushInbox(token, renderLoopDetectedMessage());
      this.pushInbox(partnerToken, renderLoopDetectedMessage());
      wakeTokens.add(token);
      wakeTokens.add(partnerToken);
      return { kind: 'loop_paused', wakeTokens: [...wakeTokens] };
    }

    this.pushInbox(partnerToken, formatDeliveredMessage(token, data, signaled));
    partner.recentShortMessageCount = 0;
    this.sendsTotal += 1;
    wakeTokens.add(partnerToken);
    return { kind: 'delivered', wakeTokens: [...wakeTokens] };
  }

  public async touchParticipant(token: string): Promise<TouchParticipantResult> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (!tokenRecord.roomName) {
      return 'not_in_room';
    }

    tokenRecord.lastSeen = Date.now();
    return 'ok';
  }

  public async consumeInbox(token: string): Promise<string | null> {
    this.cleanupExpired();
    const inbox = this.inboxes.get(token);
    if (!inbox || inbox.length === 0) {
      return null;
    }

    const message = inbox.shift();
    if (!message) {
      return null;
    }

    if (inbox.length === 0) {
      this.inboxes.delete(token);
    }

    if (message.closeAfterDelivery) {
      const tokenRecord = this.tokens.get(token);
      if (tokenRecord) {
        tokenRecord.pendingCloseMessages = Math.max(0, tokenRecord.pendingCloseMessages - 1);
        if (tokenRecord.pendingCloseMessages === 0) {
          this.finalizeToken(token);
        }
      }
    }

    return message.text;
  }

  public async incrementWaits(): Promise<void> {
    this.waitsTotal += 1;
  }

  public async registerWaiterOwner(token: string, instanceId: string, ttlMs: number): Promise<void> {
    this.waiterOwners.set(token, { instanceId, expiresAt: Date.now() + ttlMs });
  }

  public async clearWaiterOwner(token: string, instanceId: string): Promise<void> {
    const owner = this.waiterOwners.get(token);
    if (owner?.instanceId === instanceId) {
      this.waiterOwners.delete(token);
    }
  }

  public async leaveSession(token: string): Promise<LeaveSessionResult> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return { kind: 'unauthorized', wakeTokens: [] };
    }
    if (!tokenRecord.roomName || !tokenRecord.role) {
      return { kind: 'not_in_room', wakeTokens: [] };
    }

    const room = this.rooms.get(tokenRecord.roomName);
    if (!room) {
      this.tokens.delete(token);
      return { kind: 'not_in_room', wakeTokens: [] };
    }

    const wakeTokens = new Set<string>();
    const partnerToken = tokenRecord.role === 'host' ? room.joinerToken : room.hostToken;

    if (tokenRecord.role === 'host') {
      room.hostToken = null;
      this.tokens.delete(token);
      if (partnerToken && this.tokens.has(partnerToken)) {
        this.markTokenForClose(partnerToken, renderHostClosedMessage(), 2);
        wakeTokens.add(partnerToken);
      }
      this.deleteRoomIfEmpty(room.roomName);
      return { kind: 'left', wakeTokens: [...wakeTokens] };
    }

    room.joinerToken = null;
    this.tokens.delete(token);
    if (partnerToken && this.tokens.has(partnerToken)) {
      this.markTokenForClose(partnerToken, renderPartnerLeftMessage(token), 1);
      wakeTokens.add(partnerToken);
    }
    this.deleteRoomIfEmpty(room.roomName);
    return { kind: 'left', wakeTokens: [...wakeTokens] };
  }

  public async ping(token: string): Promise<PingResult> {
    this.cleanupExpired();
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return { kind: 'unauthorized' };
    }
    if (!tokenRecord.roomName || !tokenRecord.role) {
      return { kind: 'not_in_room' };
    }

    const room = this.rooms.get(tokenRecord.roomName);
    if (!room) {
      return { kind: 'not_in_room' };
    }

    const partnerToken = tokenRecord.role === 'host' ? room.joinerToken : room.hostToken;
    const partner = partnerToken ? this.tokens.get(partnerToken) : undefined;
    return {
      kind: 'ok',
      partnerConnected: !!partner,
      partnerLastSeenMs: partner ? Date.now() - partner.lastSeen : null,
    };
  }

  public async setDrainMode(enabled: boolean): Promise<void> {
    this.drainMode = enabled;
  }

  public async getDrainMode(): Promise<boolean> {
    return this.drainMode;
  }

  public async getMetricsSnapshot(openWaiters: number): Promise<BrokerMetricsSnapshot> {
    this.cleanupExpired();
    let activeSessions = 0;
    let waitingSessions = 0;
    for (const room of this.rooms.values()) {
      if (room.hostToken && room.joinerToken) {
        activeSessions += 1;
      } else {
        waitingSessions += 1;
      }
    }

    let queuedInboxCount = 0;
    for (const messages of this.inboxes.values()) {
      queuedInboxCount += messages.length;
    }

    return {
      activeSessions,
      waitingSessions,
      queuedInboxCount,
      openWaiters,
      sendsTotal: this.sendsTotal,
      waitsTotal: this.waitsTotal,
      rateLimitHitsTotal: this.rateLimitHitsTotal,
      drainMode: this.drainMode,
    };
  }

  public async consumeRateLimit(
    scope: string,
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitDecision> {
    this.cleanupExpired();
    const compositeKey = `${scope}:${key}`;
    const now = Date.now();
    const existing = this.rateLimits.get(compositeKey);
    if (!existing || existing.resetAt <= now) {
      this.rateLimits.set(compositeKey, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    if (existing.count >= max) {
      this.rateLimitHitsTotal += 1;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.count += 1;
    return { allowed: true };
  }

  public async invalidateByToken(token: string): Promise<InvalidationResult> {
    return this.closeSessionByToken(token, renderAdminClosedMessage());
  }

  public async invalidateByCode(code: string): Promise<InvalidationResult> {
    this.cleanupExpired();
    const codeRecord = this.codes.get(code);
    if (!codeRecord) {
      return { ok: false, wakeTokens: [] };
    }
    this.codes.delete(code);
    return this.closeRoom(codeRecord.roomName, renderAdminClosedMessage());
  }

  public async invalidateByRoomName(roomName: string): Promise<InvalidationResult> {
    return this.closeRoom(roomName, renderAdminClosedMessage());
  }

  public async close(): Promise<void> {
    return;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [code, record] of this.codes.entries()) {
      if (record.expiresAt <= now) {
        this.codes.delete(code);
      }
    }

    for (const [token, owner] of this.waiterOwners.entries()) {
      if (owner.expiresAt <= now) {
        this.waiterOwners.delete(token);
      }
    }

    for (const [token, messages] of this.inboxes.entries()) {
      const filtered = messages.filter((message) => message.expiresAt > now);
      if (filtered.length === 0) {
        this.inboxes.delete(token);
      } else if (filtered.length !== messages.length) {
        this.inboxes.set(token, filtered);
      }
    }

    for (const [roomName, room] of this.rooms.entries()) {
      const participants = [room.hostToken, room.joinerToken]
        .map((token) => (token ? this.tokens.get(token) : undefined))
        .filter((value): value is TokenRecord => !!value);

      if (participants.length === 0) {
        this.rooms.delete(roomName);
        continue;
      }

      const roomAgeTtl = participants.length === 1 ? this.config.waitingRoomTtlMs : this.config.sessionIdleTtlMs;
      const newestSeen = Math.max(...participants.map((participant) => participant.lastSeen));
      const newestCreated = Math.max(...participants.map((participant) => participant.createdAt));
      const referenceTime = participants.length === 1 ? newestCreated : newestSeen;
      if (now - referenceTime > roomAgeTtl) {
        this.closeRoom(roomName, renderSessionExpiredMessage(), true);
      }
    }

    for (const [token, record] of this.tokens.entries()) {
      if (!record.roomName && now - record.createdAt > this.config.tokenTtlMs) {
        this.tokens.delete(token);
      }
    }

    for (const [key, record] of this.rateLimits.entries()) {
      if (record.resetAt <= now) {
        this.rateLimits.delete(key);
      }
    }
  }

  private pairToken(token: string, roomName: string, role: SessionRole): void {
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      throw new Error(`Token '${token}' not registered`);
    }

    tokenRecord.roomName = roomName;
    tokenRecord.role = role;
    tokenRecord.lastSeen = Date.now();
    tokenRecord.standby = false;
    tokenRecord.recentShortMessageCount = 0;
  }

  private pushInbox(token: string, text: string, closeAfterDelivery: boolean = false): void {
    const existing = this.inboxes.get(token) ?? [];
    existing.push({
      text,
      closeAfterDelivery,
      expiresAt: Date.now() + this.config.inboxTtlMs,
    });
    this.inboxes.set(token, existing);
  }

  private markTokenForClose(token: string, text: string, copies: number): void {
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return;
    }
    tokenRecord.pendingCloseMessages += copies;
    for (let index = 0; index < copies; index += 1) {
      this.pushInbox(token, text, true);
    }
  }

  private finalizeToken(token: string): void {
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return;
    }
    const roomName = tokenRecord.roomName;
    this.tokens.delete(token);
    if (!roomName) {
      return;
    }

    const room = this.rooms.get(roomName);
    if (!room) {
      return;
    }

    if (room.hostToken === token) {
      room.hostToken = null;
    }
    if (room.joinerToken === token) {
      room.joinerToken = null;
    }
    this.deleteRoomIfEmpty(roomName);
  }

  private deleteRoomIfEmpty(roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room) {
      return;
    }
    if (!room.hostToken && !room.joinerToken) {
      this.rooms.delete(roomName);
    }
  }

  private closeSessionByToken(token: string, text: string): InvalidationResult {
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord?.roomName) {
      return { ok: false, wakeTokens: [] };
    }
    return this.closeRoom(tokenRecord.roomName, text);
  }

  private closeRoom(roomName: string, text: string, expire: boolean = false): InvalidationResult {
    const room = this.rooms.get(roomName);
    if (!room) {
      return { ok: false, wakeTokens: [] };
    }

    const participants = [room.hostToken, room.joinerToken].filter((token): token is string => !!token);
    for (const token of participants) {
      this.markTokenForClose(token, text, 1);
      if (expire) {
        const tokenRecord = this.tokens.get(token);
        if (tokenRecord) {
          tokenRecord.lastSeen = Date.now();
        }
      }
    }
    return { ok: true, wakeTokens: participants };
  }
}
