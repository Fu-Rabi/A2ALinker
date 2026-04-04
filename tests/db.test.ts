/**
 * Tests for src/db.ts
 * Uses an in-memory SQLite file so each test run is isolated.
 */

// Override DB path before importing db module
process.env['DB_PATH'] = ':memory:';

// NOTE: db.ts currently hardcodes 'linker.db'. To make this fully work,
// refactor the first line of db.ts from:
//   const db = new Database('linker.db');
// to:
//   const db = new Database(process.env['DB_PATH'] ?? 'linker.db');

import {
    registerUser,
    isValidToken,
    createSecureRoom,
    redeemInvite,
    destroyToken,
    destroyRoom,
    getPairedRoom,
    pairTokenToRoom,
} from '../src/db';

describe('registerUser / isValidToken', () => {
    it('registers a token and validates it', () => {
        registerUser('tok_test01');
        expect(isValidToken('tok_test01')).toBe(true);
    });

    it('returns false for unknown tokens', () => {
        expect(isValidToken('tok_unknown')).toBe(false);
    });
});

describe('createSecureRoom', () => {
    it('returns an invite code and room name', () => {
        registerUser('tok_creator01');
        const result = createSecureRoom('tok_creator01');
        expect(result).not.toBeNull();
        expect(result!.inviteCode).toMatch(/^invite_/);
        expect(result!.internalRoomName).toMatch(/^room_/);
    });

    it('enforces the 3-room limit', () => {
        registerUser('tok_creator02');
        createSecureRoom('tok_creator02');
        createSecureRoom('tok_creator02');
        createSecureRoom('tok_creator02');
        const fourth = createSecureRoom('tok_creator02');
        expect(fourth).toBeNull();
    });
});

describe('redeemInvite', () => {
    it('redeems a valid invite and returns room name', () => {
        registerUser('tok_host01');
        const result = createSecureRoom('tok_host01')!;
        const roomName = redeemInvite(result.inviteCode);
        expect(roomName).toBe(result.internalRoomName);
    });

    it('returns null for an already-used invite (one-time use)', () => {
        registerUser('tok_host02');
        const result = createSecureRoom('tok_host02')!;
        redeemInvite(result.inviteCode); // first redemption
        const second = redeemInvite(result.inviteCode); // should fail
        expect(second).toBeNull();
    });

    it('returns null for a non-existent invite code', () => {
        expect(redeemInvite('invite_doesnotexist')).toBeNull();
    });
});

describe('destroyToken', () => {
    it('removes the token from the DB', () => {
        registerUser('tok_todelete');
        destroyToken('tok_todelete');
        expect(isValidToken('tok_todelete')).toBe(false);
    });
});

describe('destroyRoom', () => {
    it('cascades and removes users in the room', () => {
        registerUser('tok_roomhost');
        registerUser('tok_roomjoiner');
        const result = createSecureRoom('tok_roomhost')!;
        pairTokenToRoom('tok_roomhost', result.internalRoomName);
        pairTokenToRoom('tok_roomjoiner', result.internalRoomName);
        destroyRoom(result.internalRoomName);
        expect(getPairedRoom('tok_roomhost')).toBeNull();
        expect(getPairedRoom('tok_roomjoiner')).toBeNull();
    });
});