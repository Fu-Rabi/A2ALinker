import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import { logger } from './logger';
import { shouldIgnoreSqliteAddColumnError } from './sqlite-migration';

const dbPath = process.env['DB_PATH'] ?? 'linker.db';
const db = new Database(dbPath);

// Secure Database settings for speed and safety
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Restrict db file permissions
if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
  fs.chmodSync(dbPath, 0o600);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY,
    room_internal_name TEXT,
    paired_at DATETIME
  );
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_name TEXT NOT NULL UNIQUE,
    creator_token TEXT NOT NULL,
    headless INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(creator_token) REFERENCES users(token)
  );

  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    room_internal_name TEXT NOT NULL,
    code_type TEXT NOT NULL DEFAULT 'invite',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_internal_name) REFERENCES rooms(internal_name)
  );
`);

// Migrations for existing databases that predate these columns
applyAddColumnMigration(
  "ALTER TABLE rooms ADD COLUMN headless INTEGER NOT NULL DEFAULT 0",
  'headless',
);
applyAddColumnMigration(
  "ALTER TABLE invites ADD COLUMN code_type TEXT NOT NULL DEFAULT 'invite'",
  'code_type',
);

/**
 * On startup: wipe any tokens that were mid-session when the process last crashed.
 * These are permanently orphaned — their SSH connection never fired 'end'/'close'.
 */
(function cleanOrphanedSessions() {
  db.prepare('DELETE FROM invites').run();
  db.prepare('DELETE FROM rooms').run();
  db.prepare('DELETE FROM users').run();
})();

/**
 * Register a new user
 */
export function registerUser(token: string) {
  const stmt = db.prepare('INSERT INTO users (token) VALUES (?)');
  stmt.run(token);
}

/**
 * Check if the token exists
 */
export function isValidToken(token: string): boolean {
  const stmt = db.prepare('SELECT * FROM users WHERE token = ?');
  return !!stmt.get(token);
}

/**
 * Set the headless room rule (autonomous mode — suppresses all agent prompts).
 */
export function setRoomHeadless(internalRoomName: string, headless: boolean): void {
  db.prepare('UPDATE rooms SET headless = ? WHERE internal_name = ?')
    .run(headless ? 1 : 0, internalRoomName);
}

/**
 * Get the headless room rule for a room.
 */
export function getRoomHeadless(internalRoomName: string): boolean {
  const row = db.prepare('SELECT headless FROM rooms WHERE internal_name = ?')
    .get(internalRoomName) as { headless: number } | undefined;
  return row?.headless === 1;
}

/**
 * Get the creator_token for a room.
 */
export function getRoomCreatorToken(internalRoomName: string): string | null {
  const row = db.prepare('SELECT creator_token FROM rooms WHERE internal_name = ?')
    .get(internalRoomName) as { creator_token: string } | undefined;
  return row?.creator_token || null;
}

/**
 * Creates a new secure, private room and returns a one-time invite code.
 * The room's internal name is random and never shared with users.
 */
export function createSecureRoom(creatorToken: string): { inviteCode: string; internalRoomName: string } | null {
  const result = createRoomWithCode(creatorToken, 'invite_', 'invite');
  if (!result) {
    return null;
  }

  return { inviteCode: result.code, internalRoomName: result.internalRoomName };
}

/**
 * Creates a pre-staged listener room and returns a one-time listen_ code.
 * The redeemer of this code becomes HOST.
 */
export function createListenerRoom(creatorToken: string): { listenerCode: string; internalRoomName: string } | null {
  const result = createRoomWithCode(creatorToken, 'listen_', 'listener');
  if (!result) {
    return null;
  }

  return { listenerCode: result.code, internalRoomName: result.internalRoomName };
}

/**
 * Redeems a one-time invite or listener code.
 * On success, returns the internal room name, code type, and DESTROYS the code.
 * Returns null if the code is invalid or already used.
 */
export function redeemInvite(inviteCode: string): { roomName: string; codeType: 'invite' | 'listener' } | null {
  // Wrap in an IMMEDIATE transaction to prevent race conditions.
  // Two agents simultaneously redeeming the same code cannot both succeed.
  const redeemTx = db.transaction((code: string) => {
    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
      { room_internal_name: string; code_type: string } | undefined;
    if (!invite) return null;
    // Burn the code atomically — one-time use
    db.prepare('DELETE FROM invites WHERE code = ?').run(code);
    return { roomName: invite.room_internal_name, codeType: invite.code_type as 'invite' | 'listener' };
  });

  return redeemTx(inviteCode) as { roomName: string; codeType: 'invite' | 'listener' } | null;
}

/**
 * Get the room the token is paired to.
 */
export function getPairedRoom(token: string): string | null {
  const user = db.prepare('SELECT room_internal_name FROM users WHERE token = ?').get(token) as { room_internal_name: string | null } | undefined;
  return user?.room_internal_name || null;
}

/**
 * Pair a user's token strictly to a room.
 */
export function pairTokenToRoom(token: string, room_internal_name: string) {
  db.prepare('UPDATE users SET room_internal_name = ?, paired_at = CURRENT_TIMESTAMP WHERE token = ?').run(room_internal_name, token);
}

/**
 * One-shot setup: Registers a new user and creates a room in a single transaction.
 * Returns the token, room name, and code (invite or listener).
 * Returns null if the 3-room limit is already reached.
 */
export function setupUserAndRoom(type: 'standard' | 'listener', headless: boolean = false): { token: string; roomName: string; code: string } | null {
  const token = 'tok_' + crypto.randomBytes(6).toString('hex');

  const setupTx = db.transaction(() => {
    // 1. Register User first so FK constraint for creator_token is satisfied
    db.prepare('INSERT INTO users (token) VALUES (?)').run(token);

    // 2. Enforce 3-room limit — check inside the transaction to avoid races
    const countRow = db.prepare('SELECT count(*) as count FROM rooms WHERE creator_token = ?')
      .get(token) as { count: number };
    // A newly registered token will always have count=0, so this guard is future-proof
    // if the caller somehow reuses a token (which the HTTP layer prevents, but still).
    if (countRow.count >= 3) return null;

    // 3. Create Room
    const internalRoomName = 'room_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO rooms (internal_name, creator_token, headless) VALUES (?, ?, ?)')
      .run(internalRoomName, token, headless ? 1 : 0);

    // 4. Create Invite/Listener Code
    const codePrefix = type === 'standard' ? 'invite_' : 'listen_';
    const code = codePrefix + crypto.randomBytes(6).toString('hex');
    const codeType = type === 'standard' ? 'invite' : 'listener';
    db.prepare('INSERT INTO invites (code, room_internal_name, code_type) VALUES (?, ?, ?)')
      .run(code, internalRoomName, codeType);

    // 5. Pair Token to Room
    db.prepare('UPDATE users SET room_internal_name = ?, paired_at = CURRENT_TIMESTAMP WHERE token = ?')
      .run(internalRoomName, token);

    return { token, roomName: internalRoomName, code };
  });

  return setupTx() as { token: string; roomName: string; code: string } | null;
}

/**
 * Atomically registers a new user token and joins an existing room in one transaction.
 * Redeems the invite code and pairs the new token — all or nothing.
 * Returns null if the invite code is invalid or already used.
 */
export function registerAndJoin(inviteCode: string): {
  token: string;
  roomName: string;
  codeType: 'invite' | 'listener';
  headless: boolean;
} | null {
  const token = 'tok_' + crypto.randomBytes(6).toString('hex');

  const joinTx = db.transaction(() => {
    // Burn the code atomically — if this fails, nothing else runs
    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(inviteCode) as
      { room_internal_name: string; code_type: string } | undefined;
    if (!invite) return null;
    db.prepare('DELETE FROM invites WHERE code = ?').run(inviteCode);

    // Register the new user
    db.prepare('INSERT INTO users (token) VALUES (?)').run(token);

    // Pair to room
    db.prepare('UPDATE users SET room_internal_name = ?, paired_at = CURRENT_TIMESTAMP WHERE token = ?')
      .run(invite.room_internal_name, token);

    const roomRow = db.prepare('SELECT headless FROM rooms WHERE internal_name = ?')
      .get(invite.room_internal_name) as { headless: number } | undefined;

    return {
      token,
      roomName: invite.room_internal_name,
      codeType: invite.code_type as 'invite' | 'listener',
      headless: roomRow?.headless === 1,
    };
  });

  return joinTx() as { token: string; roomName: string; codeType: 'invite' | 'listener'; headless: boolean } | null;
}

/**
 * Completly destroy a room and any associated tokens + invites.
 */
export function destroyRoom(room_internal_name: string) {
  // Full cascade wipe — invites, room record, and all tokens paired to this room.
  // NOTE: callers may also call destroyToken(token) afterwards for the departing token;
  // that second DELETE is a no-op (SQLite silently ignores missing rows) and is intentional
  // defensive hygiene, not a bug.
  db.prepare('DELETE FROM invites WHERE room_internal_name = ?').run(room_internal_name);
  db.prepare('DELETE FROM rooms WHERE internal_name = ?').run(room_internal_name);
  db.prepare('DELETE FROM users WHERE room_internal_name = ?').run(room_internal_name);
}

/**
 * Mark a token as destroyed to eliminate traces.
 */
export function destroyToken(token: string) {
  db.prepare('DELETE FROM users WHERE token = ?').run(token);
}

function applyAddColumnMigration(sql: string, columnName: string): void {
  try {
    db.exec(sql);
  } catch (error) {
    if (shouldIgnoreSqliteAddColumnError(error, columnName)) {
      return;
    }

    logger.error(`[A2ALinker:DB] Failed to apply startup migration for column '${columnName}'`);
    throw error;
  }
}

function createRoomWithCode(
  creatorToken: string,
  codePrefix: 'invite_' | 'listen_',
  codeType: 'invite' | 'listener',
): { code: string; internalRoomName: string } | null {
  const countStmt = db.prepare('SELECT count(*) as count FROM rooms WHERE creator_token = ?');
  const result = countStmt.get(creatorToken) as { count: number };
  if (result.count >= 3) return null;

  const internalRoomName = 'room_' + crypto.randomBytes(8).toString('hex');
  const code = codePrefix + crypto.randomBytes(6).toString('hex');

  db.prepare('INSERT INTO rooms (internal_name, creator_token) VALUES (?, ?)').run(internalRoomName, creatorToken);
  db.prepare('INSERT INTO invites (code, room_internal_name, code_type) VALUES (?, ?, ?)')
    .run(code, internalRoomName, codeType);

  return { code, internalRoomName };
}
