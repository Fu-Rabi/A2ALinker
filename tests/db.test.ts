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
    createListenerRoom,
    redeemInvite,
    destroyToken,
    destroyRoom,
    getPairedRoom,
    pairTokenToRoom,
    setRoomHeadless,
    getRoomHeadless,
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
    it('redeems a valid invite and returns roomName + codeType=invite', () => {
        registerUser('tok_host01');
        const result = createSecureRoom('tok_host01')!;
        const redeemed = redeemInvite(result.inviteCode);
        expect(redeemed).not.toBeNull();
        expect(redeemed!.roomName).toBe(result.internalRoomName);
        expect(redeemed!.codeType).toBe('invite');
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

describe('createListenerRoom', () => {
    it('returns a listen_ code and room name', () => {
        registerUser('tok_listener01');
        const result = createListenerRoom('tok_listener01');
        expect(result).not.toBeNull();
        expect(result!.listenerCode).toMatch(/^listen_/);
        expect(result!.internalRoomName).toMatch(/^room_/);
    });

    it('redeemInvite on a listen_ code returns codeType=listener', () => {
        registerUser('tok_listener02');
        const result = createListenerRoom('tok_listener02')!;
        const redeemed = redeemInvite(result.listenerCode);
        expect(redeemed).not.toBeNull();
        expect(redeemed!.roomName).toBe(result.internalRoomName);
        expect(redeemed!.codeType).toBe('listener');
    });

    it('listen_ code is one-time use', () => {
        registerUser('tok_listener03');
        const result = createListenerRoom('tok_listener03')!;
        redeemInvite(result.listenerCode);
        const second = redeemInvite(result.listenerCode);
        expect(second).toBeNull();
    });

    it('enforces the 3-room limit for listener rooms', () => {
        registerUser('tok_listener04');
        createListenerRoom('tok_listener04');
        createListenerRoom('tok_listener04');
        createListenerRoom('tok_listener04');
        const fourth = createListenerRoom('tok_listener04');
        expect(fourth).toBeNull();
    });
});

describe('setRoomHeadless / getRoomHeadless', () => {
    it('defaults to false', () => {
        registerUser('tok_headless01');
        const result = createSecureRoom('tok_headless01')!;
        expect(getRoomHeadless(result.internalRoomName)).toBe(false);
    });

    it('sets headless to true and reads it back', () => {
        registerUser('tok_headless02');
        const result = createSecureRoom('tok_headless02')!;
        setRoomHeadless(result.internalRoomName, true);
        expect(getRoomHeadless(result.internalRoomName)).toBe(true);
    });

    it('can toggle back to false', () => {
        registerUser('tok_headless03');
        const result = createSecureRoom('tok_headless03')!;
        setRoomHeadless(result.internalRoomName, true);
        setRoomHeadless(result.internalRoomName, false);
        expect(getRoomHeadless(result.internalRoomName)).toBe(false);
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