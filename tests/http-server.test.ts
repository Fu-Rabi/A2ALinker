/**
 * Integration tests for the HTTP server endpoints.
 * Uses an in-memory SQLite DB so no files are created on disk.
 */

// Must be set before importing db (via http-server)
process.env['DB_PATH'] = ':memory:';

import request from 'supertest';
import { app } from '../src/http-server';

// GET /health
describe('GET /health', () => {
    it('returns { status: ok }', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });
});

// POST /register
describe('POST /register', () => {
    it('returns a token starting with tok_', async () => {
        const res = await request(app).post('/register');
        expect(res.status).toBe(200);
        expect(res.body.token).toMatch(/^tok_/);
    });
});

// Full register → create → join flow
describe('Register → Create → Join flow', () => {
    it('HOST creates a room, JOINER joins it', async () => {
        // Register HOST
        const resHost = await request(app).post('/register');
        expect(resHost.status).toBe(200);
        const hostToken: string = resHost.body.token;
        expect(hostToken).toMatch(/^tok_/);

        // HOST creates a room
        const resCreate = await request(app)
            .post('/create')
            .set('Authorization', `Bearer ${hostToken}`);
        expect(resCreate.status).toBe(200);
        const { inviteCode } = resCreate.body;
        expect(inviteCode).toMatch(/^invite_/);

        // Register JOINER
        const resJoiner = await request(app).post('/register');
        expect(resJoiner.status).toBe(200);
        const joinToken: string = resJoiner.body.token;

        // JOINER joins the room
        const resJoined = await request(app)
            .post(`/join/${inviteCode}`)
            .set('Authorization', `Bearer ${joinToken}`);
        expect(resJoined.status).toBe(200);
        expect(resJoined.body.status).toBe('(2/2 connected)');
    });

    it('rejects an invalid invite code', async () => {
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;

        const res = await request(app)
            .post('/join/invite_doesnotexist')
            .set('Authorization', `Bearer ${hostToken}`);
        expect(res.status).toBe(404);
    });

    it('rejects /create without a valid token', async () => {
        const res = await request(app)
            .post('/create')
            .set('Authorization', 'Bearer tok_invalid');
        expect(res.status).toBe(401);
    });
});