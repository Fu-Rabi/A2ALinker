import { createClient, RedisClientType } from 'redis';
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
import { extractTrailingSignal } from './protocol';
import { generateSecret, createLookupId } from './runtime-ids';
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
  token: string;
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
  sessionType: SessionType;
  creatorToken: string;
  headless: boolean;
  hostToken: string | null;
  joinerToken: string | null;
  createdAt: number;
}

interface CodeRecord {
  roomName: string;
  codeType: 'invite' | 'listener';
}

interface InboxMessage {
  text: string;
  closeAfterDelivery: boolean;
}

export class RedisBrokerStore implements BrokerStore {
  public readonly config: RuntimeConfig;
  private readonly client: RedisClientType;

  public constructor(config: RuntimeConfig) {
    if (!config.redisUrl) {
      throw new Error('REDIS_URL is required for RedisBrokerStore');
    }

    this.config = config;
    this.client = createClient({ url: config.redisUrl });
  }

  public async registerToken(): Promise<string> {
    const token = generateSecret('tok_');
    const record: TokenRecord = {
      token,
      roomName: null,
      role: null,
      standby: false,
      recentShortMessageCount: 0,
      lastSeen: Date.now(),
      createdAt: Date.now(),
      pendingCloseMessages: 0,
    };
    await this.setToken(record, this.config.tokenTtlMs);
    return token;
  }

  public async isValidToken(token: string): Promise<boolean> {
    return (await this.getToken(token)) !== null;
  }

  public async setupSession(type: SessionType, headless: boolean): Promise<SessionSetupResult | null> {
    const token = await this.registerToken();
    const roomName = generateSecret('room_');
    const code = generateSecret(type === 'standard' ? 'invite_' : 'listen_');
    const role: SessionRole = type === 'standard' ? 'host' : 'joiner';
    const room: RoomRecord = {
      roomName,
      sessionType: type,
      creatorToken: token,
      headless,
      hostToken: role === 'host' ? token : null,
      joinerToken: role === 'joiner' ? token : null,
      createdAt: Date.now(),
    };
    await this.setRoom(room);
    await this.setCode(code, {
      roomName,
      codeType: type === 'standard' ? 'invite' : 'listener',
    }, this.getCodeTtlMs(type, headless));
    await this.pairToken(token, roomName, role);
    return { token, code, roomName, role };
  }

  public async createSession(
    token: string,
    type: SessionType,
  ): Promise<{ code: string; roomName: string } | 'unauthorized' | 'already_paired'> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (tokenRecord.roomName) {
      return 'already_paired';
    }

    const roomName = generateSecret('room_');
    const code = generateSecret(type === 'standard' ? 'invite_' : 'listen_');
    const role: SessionRole = type === 'standard' ? 'host' : 'joiner';
    await this.setRoom({
      roomName,
      sessionType: type,
      creatorToken: token,
      headless: false,
      hostToken: role === 'host' ? token : null,
      joinerToken: role === 'joiner' ? token : null,
      createdAt: Date.now(),
    });
    await this.setCode(code, {
      roomName,
      codeType: type === 'standard' ? 'invite' : 'listener',
    }, this.getCodeTtlMs(type, false));
    await this.pairToken(token, roomName, role);
    return { code, roomName };
  }

  public async joinSession(
    token: string,
    code: string,
  ): Promise<JoinSessionResult | 'unauthorized' | 'already_paired' | 'invalid_code'> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (tokenRecord.roomName) {
      return 'already_paired';
    }

    const codeRecord = await this.getCode(code);
    if (!codeRecord) {
      return 'invalid_code';
    }

    const room = await this.getRoom(codeRecord.roomName);
    if (!room) {
      await this.deleteCode(code);
      return 'invalid_code';
    }

    const role: SessionRole = codeRecord.codeType === 'listener' ? 'host' : 'joiner';
    await this.deleteCode(code);
    await this.pairToken(token, room.roomName, role);
    if (role === 'host') {
      room.hostToken = token;
    } else {
      room.joinerToken = token;
    }
    await this.setRoom(room);

    const partnerToken = role === 'host' ? room.joinerToken : room.hostToken;
    const wakeTokens: string[] = [];
    if (partnerToken) {
      await this.pushInbox(partnerToken, renderJoinMessage(token, role === 'host'));
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
    const token = await this.registerToken();
    const result = await this.joinSession(token, code);
    if (result === 'invalid_code') {
      await this.deleteToken(token);
      return 'invalid_code';
    }
    if (typeof result === 'string') {
      throw new Error(`Unexpected registerAndJoin result '${result}'`);
    }
    return { token, ...result };
  }

  public async updateRoomHeadless(token: string, headless: boolean): Promise<HeadlessUpdateStatus> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (!tokenRecord.roomName) {
      return 'not_in_room';
    }
    const room = await this.getRoom(tokenRecord.roomName);
    if (!room) {
      return 'not_in_room';
    }
    if (room.creatorToken !== token) {
      return 'forbidden';
    }
    room.headless = headless;
    await this.setRoom(room);
    tokenRecord.lastSeen = Date.now();
    await this.setToken(tokenRecord, this.config.sessionIdleTtlMs);
    return 'ok';
  }

  public async sendMessage(token: string, body: string): Promise<SendMessageResult> {
    const sender = await this.getToken(token);
    if (!sender) {
      return { kind: 'unauthorized' };
    }
    if (!sender.roomName || !sender.role) {
      return { kind: 'not_in_room' };
    }
    const room = await this.getRoom(sender.roomName);
    if (!room) {
      return { kind: 'not_in_room' };
    }
    if (await this.maybeExpireRoom(room.roomName)) {
      return { kind: 'not_in_room' };
    }

    sender.lastSeen = Date.now();
    const partnerToken = sender.role === 'host' ? room.joinerToken : room.hostToken;
    if (!partnerToken) {
      return { kind: 'partner_not_connected' };
    }
    const partner = await this.getToken(partnerToken);
    if (!partner) {
      return { kind: 'partner_not_connected' };
    }

    const parsed = extractTrailingSignal(body);
    const data = parsed.body;
    const signaled = parsed.signal;
    sender.standby = signaled === 'STANDBY';

    const wakeTokens = new Set<string>();
    if (sender.standby && partner.standby) {
      await this.pushInbox(token, renderAllStandbyMessage());
      await this.pushInbox(partnerToken, renderAllStandbyMessage());
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
      await this.pushInbox(token, renderLoopDetectedMessage());
      await this.pushInbox(partnerToken, renderLoopDetectedMessage());
      await Promise.all([
        this.setToken(sender, this.config.sessionIdleTtlMs),
        this.setToken(partner, this.config.sessionIdleTtlMs),
      ]);
      wakeTokens.add(token);
      wakeTokens.add(partnerToken);
      return { kind: 'loop_paused', wakeTokens: [...wakeTokens] };
    }

    await this.pushInbox(partnerToken, formatDeliveredMessage(token, data, signaled));
    partner.recentShortMessageCount = 0;
    await Promise.all([
      this.setToken(sender, this.config.sessionIdleTtlMs),
      this.setToken(partner, this.config.sessionIdleTtlMs),
      this.client.incr(this.counterKey('sends_total')),
    ]);
    wakeTokens.add(partnerToken);
    return { kind: 'delivered', wakeTokens: [...wakeTokens] };
  }

  public async touchParticipant(token: string): Promise<TouchParticipantResult> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return 'unauthorized';
    }
    if (!tokenRecord.roomName) {
      return 'not_in_room';
    }
    if (await this.maybeExpireRoom(tokenRecord.roomName)) {
      return 'not_in_room';
    }
    tokenRecord.lastSeen = Date.now();
    await this.setToken(tokenRecord, this.config.sessionIdleTtlMs);
    return 'ok';
  }

  public async consumeInbox(token: string): Promise<string | null> {
    const payload = await this.client.lPop(this.inboxKey(token));
    if (!payload) {
      return null;
    }

    const message = JSON.parse(payload) as InboxMessage;
    if (message.closeAfterDelivery) {
      const tokenRecord = await this.getToken(token);
      if (tokenRecord) {
        tokenRecord.pendingCloseMessages = Math.max(0, tokenRecord.pendingCloseMessages - 1);
        if (tokenRecord.pendingCloseMessages === 0) {
          await this.finalizeToken(token);
        } else {
          await this.setToken(tokenRecord, this.config.sessionIdleTtlMs);
        }
      }
    }

    return message.text;
  }

  public async incrementWaits(): Promise<void> {
    await this.client.incr(this.counterKey('waits_total'));
  }

  public async registerWaiterOwner(token: string, instanceId: string, ttlMs: number): Promise<void> {
    await this.client.set(this.waiterKey(token), instanceId, { PX: ttlMs });
  }

  public async clearWaiterOwner(token: string, instanceId: string): Promise<void> {
    const key = this.waiterKey(token);
    const current = await this.client.get(key);
    if (current === instanceId) {
      await this.client.del(key);
    }
  }

  public async leaveSession(token: string): Promise<LeaveSessionResult> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return { kind: 'unauthorized', wakeTokens: [] };
    }
    if (!tokenRecord.roomName || !tokenRecord.role) {
      return { kind: 'not_in_room', wakeTokens: [] };
    }
    const room = await this.getRoom(tokenRecord.roomName);
    if (!room) {
      await this.deleteToken(token);
      return { kind: 'not_in_room', wakeTokens: [] };
    }

    const wakeTokens = new Set<string>();
    const partnerToken = tokenRecord.role === 'host' ? room.joinerToken : room.hostToken;

    if (tokenRecord.role === 'host') {
      room.hostToken = null;
      await this.deleteToken(token);
      if (partnerToken && await this.isValidToken(partnerToken)) {
        await this.markTokenForClose(partnerToken, renderHostClosedMessage(), 2);
        wakeTokens.add(partnerToken);
      }
      await this.setRoom(room);
      await this.deleteRoomIfEmpty(room.roomName);
      return { kind: 'left', wakeTokens: [...wakeTokens] };
    }

    room.joinerToken = null;
    await this.deleteToken(token);
    if (partnerToken && await this.isValidToken(partnerToken)) {
      await this.markTokenForClose(partnerToken, renderPartnerLeftMessage(token), 1);
      wakeTokens.add(partnerToken);
    }
    await this.setRoom(room);
    await this.deleteRoomIfEmpty(room.roomName);
    return { kind: 'left', wakeTokens: [...wakeTokens] };
  }

  public async ping(token: string): Promise<PingResult> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return { kind: 'unauthorized' };
    }
    if (!tokenRecord.roomName || !tokenRecord.role) {
      return { kind: 'not_in_room' };
    }

    const room = await this.getRoom(tokenRecord.roomName);
    if (!room) {
      return { kind: 'not_in_room' };
    }

    const partnerToken = tokenRecord.role === 'host' ? room.joinerToken : room.hostToken;
    const partner = partnerToken ? await this.getToken(partnerToken) : null;
    return {
      kind: 'ok',
      partnerConnected: !!partner,
      partnerLastSeenMs: partner ? Date.now() - partner.lastSeen : null,
    };
  }

  public async setDrainMode(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.client.set(this.counterKey('drain_mode'), '1');
      return;
    }

    await this.client.del(this.counterKey('drain_mode'));
  }

  public async getDrainMode(): Promise<boolean> {
    return (await this.client.get(this.counterKey('drain_mode'))) === '1';
  }

  public async getMetricsSnapshot(openWaiters: number): Promise<BrokerMetricsSnapshot> {
    const roomKeys = await this.scanKeys('a2a:room:*');
    let activeSessions = 0;
    let waitingSessions = 0;
    for (const key of roomKeys) {
      const payload = await this.client.get(key);
      if (!payload) {
        continue;
      }
      const room = JSON.parse(payload) as RoomRecord;
      if (room.hostToken && room.joinerToken) {
        activeSessions += 1;
      } else {
        waitingSessions += 1;
      }
    }

    const inboxKeys = await this.scanKeys('a2a:inbox:*');
    let queuedInboxCount = 0;
    for (const key of inboxKeys) {
      queuedInboxCount += await this.client.lLen(key);
    }

    const [sendsTotal, waitsTotal, rateLimitHitsTotal, drainMode] = await Promise.all([
      this.client.get(this.counterKey('sends_total')),
      this.client.get(this.counterKey('waits_total')),
      this.client.get(this.counterKey('rate_limit_hits_total')),
      this.getDrainMode(),
    ]);

    return {
      activeSessions,
      waitingSessions,
      queuedInboxCount,
      openWaiters,
      sendsTotal: Number.parseInt(sendsTotal ?? '0', 10),
      waitsTotal: Number.parseInt(waitsTotal ?? '0', 10),
      rateLimitHitsTotal: Number.parseInt(rateLimitHitsTotal ?? '0', 10),
      drainMode,
    };
  }

  public async consumeRateLimit(
    scope: string,
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitDecision> {
    const rateKey = `${this.counterKey('rate_limit')}:${scope}:${createLookupId(key, this.config.lookupHmacKey)}`;
    const count = await this.client.incr(rateKey);
    if (count === 1) {
      await this.client.pExpire(rateKey, windowMs);
    }

    if (count > max) {
      await this.client.incr(this.counterKey('rate_limit_hits_total'));
      const ttlMs = await this.client.pTTL(rateKey);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(1, ttlMs) / 1000)),
      };
    }

    return { allowed: true };
  }

  public async invalidateByToken(token: string): Promise<InvalidationResult> {
    return this.closeSessionByToken(token, renderAdminClosedMessage());
  }

  public async invalidateByCode(code: string): Promise<InvalidationResult> {
    const codeRecord = await this.getCode(code);
    if (!codeRecord) {
      return { ok: false, wakeTokens: [] };
    }
    await this.deleteCode(code);
    return this.closeRoom(codeRecord.roomName, renderAdminClosedMessage());
  }

  public async invalidateByRoomName(roomName: string): Promise<InvalidationResult> {
    return this.closeRoom(roomName, renderAdminClosedMessage());
  }

  public async close(): Promise<void> {
    await this.client.quit();
  }

  public async connect(): Promise<void> {
    await this.client.connect();
  }

  private async getToken(token: string): Promise<TokenRecord | null> {
    const payload = await this.client.get(this.tokenKey(token));
    if (!payload) {
      return null;
    }
    return JSON.parse(payload) as TokenRecord;
  }

  private async setToken(record: TokenRecord, ttlMs: number): Promise<void> {
    await this.client.set(this.tokenKey(record.token), JSON.stringify(record), { PX: ttlMs });
  }

  private async deleteToken(token: string): Promise<void> {
    await this.client.del([
      this.tokenKey(token),
      this.inboxKey(token),
      this.waiterKey(token),
    ]);
  }

  private async getRoom(roomName: string): Promise<RoomRecord | null> {
    const payload = await this.client.get(this.roomKey(roomName));
    if (!payload) {
      return null;
    }
    return JSON.parse(payload) as RoomRecord;
  }

  private async setRoom(room: RoomRecord): Promise<void> {
    const ttlMs = room.hostToken && room.joinerToken
      ? this.config.sessionIdleTtlMs
      : this.getWaitingRoomTtlMs(room);
    await this.client.set(this.roomKey(room.roomName), JSON.stringify(room), { PX: ttlMs });
  }

  private async setCode(code: string, record: CodeRecord, ttlMs: number): Promise<void> {
    await this.client.set(this.codeKey(code), JSON.stringify(record), { PX: ttlMs });
  }

  private async getCode(code: string): Promise<CodeRecord | null> {
    const payload = await this.client.get(this.codeKey(code));
    if (!payload) {
      return null;
    }
    return JSON.parse(payload) as CodeRecord;
  }

  private async deleteCode(code: string): Promise<void> {
    await this.client.del(this.codeKey(code));
  }

  private async pairToken(token: string, roomName: string, role: SessionRole): Promise<void> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      throw new Error(`Token '${token}' not found`);
    }

    tokenRecord.roomName = roomName;
    tokenRecord.role = role;
    tokenRecord.lastSeen = Date.now();
    tokenRecord.standby = false;
    tokenRecord.recentShortMessageCount = 0;
    await this.setToken(tokenRecord, this.config.sessionIdleTtlMs);
  }

  private async pushInbox(token: string, text: string, closeAfterDelivery: boolean = false): Promise<void> {
    await this.client.rPush(this.inboxKey(token), JSON.stringify({ text, closeAfterDelivery } satisfies InboxMessage));
    await this.client.pExpire(this.inboxKey(token), this.config.inboxTtlMs);
  }

  private async markTokenForClose(token: string, text: string, copies: number): Promise<void> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord) {
      return;
    }
    tokenRecord.pendingCloseMessages += copies;
    await this.setToken(tokenRecord, this.config.sessionIdleTtlMs);
    for (let index = 0; index < copies; index += 1) {
      await this.pushInbox(token, text, true);
    }
  }

  private async finalizeToken(token: string): Promise<void> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord?.roomName) {
      await this.deleteToken(token);
      return;
    }
    const room = await this.getRoom(tokenRecord.roomName);
    if (room) {
      if (room.hostToken === token) {
        room.hostToken = null;
      }
      if (room.joinerToken === token) {
        room.joinerToken = null;
      }
      await this.setRoom(room);
      await this.deleteRoomIfEmpty(room.roomName);
    }
    await this.deleteToken(token);
  }

  private async closeSessionByToken(token: string, text: string): Promise<InvalidationResult> {
    const tokenRecord = await this.getToken(token);
    if (!tokenRecord?.roomName) {
      return { ok: false, wakeTokens: [] };
    }
    return this.closeRoom(tokenRecord.roomName, text);
  }

  private async closeRoom(roomName: string, text: string): Promise<InvalidationResult> {
    const room = await this.getRoom(roomName);
    if (!room) {
      return { ok: false, wakeTokens: [] };
    }
    const participants = [room.hostToken, room.joinerToken].filter((token): token is string => !!token);
    for (const token of participants) {
      if (token) {
        await this.markTokenForClose(token, text, 1);
      }
    }
    return { ok: true, wakeTokens: participants };
  }

  private async maybeExpireRoom(roomName: string): Promise<boolean> {
    const room = await this.getRoom(roomName);
    if (!room) {
      return true;
    }
    const participants = [room.hostToken, room.joinerToken].filter((token): token is string => !!token);
    if (participants.length === 0) {
      await this.client.del(this.roomKey(roomName));
      return true;
    }

    const records = await Promise.all(participants.map((token) => this.getToken(token)));
    const validRecords = records.filter((record): record is TokenRecord => !!record);
    if (validRecords.length === 0) {
      await this.client.del(this.roomKey(roomName));
      return true;
    }

    const ttlMs = validRecords.length === 1 ? this.getWaitingRoomTtlMs(room) : this.config.sessionIdleTtlMs;
    const referenceTime = validRecords.length === 1
      ? Math.max(...validRecords.map((record) => record.createdAt))
      : Math.max(...validRecords.map((record) => record.lastSeen));

    if (Date.now() - referenceTime > ttlMs) {
      await this.closeRoom(roomName, renderSessionExpiredMessage());
      return false;
    }

    return false;
  }

  private async deleteRoomIfEmpty(roomName: string): Promise<void> {
    const room = await this.getRoom(roomName);
    if (!room) {
      return;
    }
    if (!room.hostToken && !room.joinerToken) {
      await this.client.del(this.roomKey(roomName));
    }
  }

  private getCodeTtlMs(type: SessionType, headless: boolean): number {
    if (type === 'listener' && headless) {
      return this.config.headlessListenerCodeTtlMs;
    }
    return this.config.codeTtlMs;
  }

  private getWaitingRoomTtlMs(room: RoomRecord): number {
    if (room.sessionType === 'listener' && room.headless) {
      return this.config.headlessListenerWaitingRoomTtlMs;
    }
    return this.config.waitingRoomTtlMs;
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of this.client.scanIterator({ MATCH: pattern })) {
      if (Array.isArray(key)) {
        keys.push(...key);
      } else {
        keys.push(key);
      }
    }
    return keys;
  }

  private counterKey(name: string): string {
    return `a2a:counter:${name}`;
  }

  private tokenKey(token: string): string {
    return `a2a:token:${createLookupId(token, this.config.lookupHmacKey)}`;
  }

  private roomKey(roomName: string): string {
    return `a2a:room:${createLookupId(roomName, this.config.lookupHmacKey)}`;
  }

  private codeKey(code: string): string {
    return `a2a:code:${createLookupId(code, this.config.lookupHmacKey)}`;
  }

  private inboxKey(token: string): string {
    return `a2a:inbox:${createLookupId(token, this.config.lookupHmacKey)}`;
  }

  private waiterKey(token: string): string {
    return `a2a:waiter:${createLookupId(token, this.config.lookupHmacKey)}`;
  }
}
