import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';

const db = new Database('linker.db');

// Secure Database settings for speed and safety
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Restrict db file permissions
if (fs.existsSync('linker.db')) {
  fs.chmodSync('linker.db', 0o600);
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(creator_token) REFERENCES users(token)
  );

  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    room_internal_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_internal_name) REFERENCES rooms(internal_name)
  );
`);

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
 * Creates a new secure, private room and returns a one-time invite code.
 * The room's internal name is random and never shared with users.
 */
export function createSecureRoom(creatorToken: string): { inviteCode: string; internalRoomName: string } | null {
  // Enforce 3-room limit per user
  const countStmt = db.prepare('SELECT count(*) as count FROM rooms WHERE creator_token = ?');
  const result = countStmt.get(creatorToken) as { count: number };
  if (result.count >= 3) return null;

  const internalRoomName = 'room_' + crypto.randomBytes(8).toString('hex');
  const inviteCode = 'invite_' + crypto.randomBytes(6).toString('hex');

  const createRoom = db.prepare('INSERT INTO rooms (internal_name, creator_token) VALUES (?, ?)');
  createRoom.run(internalRoomName, creatorToken);

  const createInvite = db.prepare('INSERT INTO invites (code, room_internal_name) VALUES (?, ?)');
  createInvite.run(inviteCode, internalRoomName);

  return { inviteCode, internalRoomName };
}

/**
 * Redeems a one-time invite code.
 * On success, returns the internal room name and DESTROYS the invite code.
 * Returns null if the code is invalid or already used.
 */
export function redeemInvite(inviteCode: string): string | null {
  // Wrap in an IMMEDIATE transaction to prevent race conditions.
  // Two agents simultaneously redeeming the same code cannot both succeed.
  const redeemTx = db.transaction((code: string) => {
    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as { room_internal_name: string } | undefined;
    if (!invite) return null;
    // Burn the invite code atomically — one-time use
    db.prepare('DELETE FROM invites WHERE code = ?').run(code);
    return invite.room_internal_name;
  });

  return redeemTx(inviteCode) as string | null;
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
 * Completly destroy a room and any associated tokens + invites.
 */
export function destroyRoom(room_internal_name: string) {
  // Cascades and explicitly delete tokens to ensure no trace is left
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
