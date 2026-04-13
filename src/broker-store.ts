import { RuntimeConfig } from './config';

export type SessionRole = 'host' | 'joiner';
export type SessionType = 'standard' | 'listener';
export type CloseReason = 'host_closed' | 'partner_left' | 'idle_expired' | 'admin_invalidated';

export interface SessionParticipant {
  token: string;
  roomName: string;
  role: SessionRole;
  standby: boolean;
  lastSeen: number;
}

export interface SessionSetupResult {
  token: string;
  code: string;
  roomName: string;
  role: SessionRole;
}

export interface JoinSessionResult {
  roomName: string;
  role: SessionRole;
  headless: boolean;
  wakeTokens: string[];
}

export interface RegisterAndJoinResult extends JoinSessionResult {
  token: string;
}

export type HeadlessUpdateStatus = 'ok' | 'unauthorized' | 'not_in_room' | 'forbidden';

export type SendMessageResult =
  | { kind: 'unauthorized' }
  | { kind: 'not_in_room' }
  | { kind: 'partner_not_connected' }
  | { kind: 'delivered'; wakeTokens: string[] }
  | { kind: 'loop_paused'; wakeTokens: string[] };

export type TouchParticipantResult = 'ok' | 'unauthorized' | 'not_in_room';

export interface LeaveSessionResult {
  kind: 'unauthorized' | 'not_in_room' | 'left';
  wakeTokens: string[];
}

export interface InvalidationResult {
  ok: boolean;
  wakeTokens: string[];
}

export type PingResult =
  | { kind: 'unauthorized' }
  | { kind: 'not_in_room' }
  | { kind: 'ok'; partnerConnected: boolean; partnerLastSeenMs: number | null };

export interface BrokerMetricsSnapshot {
  activeSessions: number;
  waitingSessions: number;
  queuedInboxCount: number;
  openWaiters: number;
  sendsTotal: number;
  waitsTotal: number;
  rateLimitHitsTotal: number;
  drainMode: boolean;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface BrokerStore {
  readonly config: RuntimeConfig;
  registerToken(): Promise<string>;
  isValidToken(token: string): Promise<boolean>;
  setupSession(type: SessionType, headless: boolean): Promise<SessionSetupResult | null>;
  createSession(token: string, type: SessionType): Promise<{ code: string; roomName: string } | 'unauthorized' | 'already_paired'>;
  joinSession(token: string, code: string): Promise<JoinSessionResult | 'unauthorized' | 'already_paired' | 'invalid_code'>;
  registerAndJoin(code: string): Promise<RegisterAndJoinResult | 'invalid_code'>;
  updateRoomHeadless(token: string, headless: boolean): Promise<HeadlessUpdateStatus>;
  sendMessage(token: string, body: string): Promise<SendMessageResult>;
  touchParticipant(token: string): Promise<TouchParticipantResult>;
  consumeInbox(token: string): Promise<string | null>;
  incrementWaits(): Promise<void>;
  registerWaiterOwner(token: string, instanceId: string, ttlMs: number): Promise<void>;
  clearWaiterOwner(token: string, instanceId: string): Promise<void>;
  leaveSession(token: string): Promise<LeaveSessionResult>;
  ping(token: string): Promise<PingResult>;
  setDrainMode(enabled: boolean): Promise<void>;
  getDrainMode(): Promise<boolean>;
  getMetricsSnapshot(openWaiters: number): Promise<BrokerMetricsSnapshot>;
  consumeRateLimit(
    scope: string,
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitDecision>;
  invalidateByToken(token: string): Promise<InvalidationResult>;
  invalidateByCode(code: string): Promise<InvalidationResult>;
  invalidateByRoomName(roomName: string): Promise<InvalidationResult>;
  close(): Promise<void>;
}
