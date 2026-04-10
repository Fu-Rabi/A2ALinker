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

    it('POST /join returns role=joiner and headless=false by default', async () => {
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        const resCreate = await request(app)
            .post('/create')
            .set('Authorization', `Bearer ${hostToken}`);
        const { inviteCode } = resCreate.body;

        const resJoiner = await request(app).post('/register');
        const joinToken: string = resJoiner.body.token;
        const resJoined = await request(app)
            .post(`/join/${inviteCode}`)
            .set('Authorization', `Bearer ${joinToken}`);

        expect(resJoined.status).toBe(200);
        expect(resJoined.body.role).toBe('joiner');
        expect(resJoined.body.headless).toBe(false);
    });
});

// POST /listen
describe('POST /listen', () => {
    it('returns a listenerCode starting with listen_', async () => {
        const res = await request(app).post('/register');
        const token: string = res.body.token;
        const resListen = await request(app)
            .post('/listen')
            .set('Authorization', `Bearer ${token}`);
        expect(resListen.status).toBe(200);
        expect(resListen.body.listenerCode).toMatch(/^listen_/);
        expect(resListen.body.roomName).toMatch(/^room_/);
    });

    it('rejects without a valid token', async () => {
        const res = await request(app)
            .post('/listen')
            .set('Authorization', 'Bearer tok_invalid');
        expect(res.status).toBe(401);
    });
});

// Listener mode flow
describe('Listener mode — JOINER pre-stages, HOST redeems listen_ code', () => {
    it('HOST joins via listen_ code and gets role=host', async () => {
        // JOINER pre-stages
        const resJoiner = await request(app).post('/register');
        const joinerToken: string = resJoiner.body.token;
        const resListen = await request(app)
            .post('/listen')
            .set('Authorization', `Bearer ${joinerToken}`);
        expect(resListen.status).toBe(200);
        const { listenerCode } = resListen.body;
        expect(listenerCode).toMatch(/^listen_/);

        // HOST redeems
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        const resJoined = await request(app)
            .post(`/join/${listenerCode}`)
            .set('Authorization', `Bearer ${hostToken}`);

        expect(resJoined.status).toBe(200);
        expect(resJoined.body.role).toBe('host');
        expect(resJoined.body.status).toBe('(2/2 connected)');
    });

    it('listen_ code is one-time use', async () => {
        const res1 = await request(app).post('/register');
        const joinerToken: string = res1.body.token;
        const resListen = await request(app)
            .post('/listen')
            .set('Authorization', `Bearer ${joinerToken}`);
        const { listenerCode } = resListen.body;

        // First redemption
        const res2 = await request(app).post('/register');
        await request(app)
            .post(`/join/${listenerCode}`)
            .set('Authorization', `Bearer ${res2.body.token}`);

        // Second redemption — should fail
        const res3 = await request(app).post('/register');
        const resDupe = await request(app)
            .post(`/join/${listenerCode}`)
            .set('Authorization', `Bearer ${res3.body.token}`);
        expect(resDupe.status).toBe(404);
    });
});

// POST /room-rule/headless
describe('POST /room-rule/headless', () => {
    it('HOST can set headless to true', async () => {
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        await request(app).post('/create').set('Authorization', `Bearer ${hostToken}`);

        const res = await request(app)
            .post('/room-rule/headless')
            .set('Authorization', `Bearer ${hostToken}`)
            .set('Content-Type', 'application/json')
            .send({ headless: true });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('headless=true propagates to JOINER in join response', async () => {
        // HOST creates room and sets headless
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        const resCreate = await request(app)
            .post('/create')
            .set('Authorization', `Bearer ${hostToken}`);
        const { inviteCode } = resCreate.body;
        await request(app)
            .post('/room-rule/headless')
            .set('Authorization', `Bearer ${hostToken}`)
            .set('Content-Type', 'application/json')
            .send({ headless: true });

        // JOINER joins — should receive headless=true
        const resJoiner = await request(app).post('/register');
        const joinToken: string = resJoiner.body.token;
        const resJoined = await request(app)
            .post(`/join/${inviteCode}`)
            .set('Authorization', `Bearer ${joinToken}`);

        expect(resJoined.status).toBe(200);
        expect(resJoined.body.headless).toBe(true);
    });

    it('JOINER cannot set headless room rule', async () => {
        // Setup a full session
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        const resCreate = await request(app)
            .post('/create')
            .set('Authorization', `Bearer ${hostToken}`);
        const { inviteCode } = resCreate.body;

        const resJoiner = await request(app).post('/register');
        const joinToken: string = resJoiner.body.token;
        await request(app)
            .post(`/join/${inviteCode}`)
            .set('Authorization', `Bearer ${joinToken}`);

        // JOINER tries to set headless — should be forbidden
        const res = await request(app)
            .post('/room-rule/headless')
            .set('Authorization', `Bearer ${joinToken}`)
            .set('Content-Type', 'application/json')
            .send({ headless: true });
        expect(res.status).toBe(403);
    });

    it('rejects missing headless field', async () => {
        const resHost = await request(app).post('/register');
        const hostToken: string = resHost.body.token;
        await request(app).post('/create').set('Authorization', `Bearer ${hostToken}`);

        const res = await request(app)
            .post('/room-rule/headless')
            .set('Authorization', `Bearer ${hostToken}`)
            .set('Content-Type', 'application/json')
            .send({});
        expect(res.status).toBe(400);
    });
});

async function createStandardSession(): Promise<{ hostToken: string; joinToken: string }> {
    const resSetup = await request(app)
        .post('/setup')
        .set('Content-Type', 'application/json')
        .send({ type: 'standard', headless: true });

    const hostToken: string = resSetup.body.token;
    const inviteCode: string = resSetup.body.code;

    const resJoin = await request(app)
        .post(`/register-and-join/${inviteCode}`);

    const joinToken: string = resJoin.body.token;
    return { hostToken, joinToken };
}

async function createStandardSessionWith(client: ReturnType<typeof request>): Promise<{ hostToken: string; joinToken: string }> {
    const resSetup = await client
        .post('/setup')
        .set('Content-Type', 'application/json')
        .send({ type: 'standard', headless: true });

    const hostToken: string = resSetup.body.token;
    const inviteCode: string = resSetup.body.code;

    const resJoin = await client
        .post(`/register-and-join/${inviteCode}`);

    const joinToken: string = resJoin.body.token;
    return { hostToken, joinToken };
}

describe('HTTP wait/send behavior', () => {
    it('returns a queued message immediately when the receiver waits later', async () => {
        const { hostToken, joinToken } = await createStandardSession();

        const sendRes = await request(app)
            .post('/send')
            .set('Authorization', `Bearer ${hostToken}`)
            .set('Content-Type', 'text/plain')
            .send('Queued hello [OVER]');

        expect(sendRes.status).toBe(200);
        expect(sendRes.text).toBe('DELIVERED');

        const waitRes = await request(app)
            .get('/wait')
            .set('Authorization', `Bearer ${joinToken}`);

        expect(waitRes.status).toBe(200);
        expect(waitRes.text).toContain('MESSAGE_RECEIVED');
        expect(waitRes.text).toContain('Queued hello');
        expect(waitRes.text).toContain('[OVER]');
    });

    it('releases a held /wait request as soon as the partner sends', async () => {
        const server = app.listen();
        const client = request(server);

        try {
            const { hostToken, joinToken } = await createStandardSessionWith(client);

            const waitPromise = client
                .get('/wait')
                .set('Authorization', `Bearer ${joinToken}`);

            await new Promise((resolve) => setTimeout(resolve, 20));

            const sendRes = await client
                .post('/send')
                .set('Authorization', `Bearer ${hostToken}`)
                .set('Content-Type', 'text/plain')
                .send('Immediate release [OVER]');

            expect(sendRes.status).toBe(200);
            expect(sendRes.text).toBe('DELIVERED');

            const waitRes = await waitPromise;
            expect(waitRes.status).toBe(200);
            expect(waitRes.text).toContain('Immediate release');
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    });

    it('delivers listener join notification first and then the real host message', async () => {
        const server = app.listen();
        const client = request(server);

        try {
            const resListen = await client
                .post('/setup')
                .set('Content-Type', 'application/json')
                .send({ type: 'listener', headless: true });

            const joinToken: string = resListen.body.token;
            const listenerCode: string = resListen.body.code;

            const systemWaitPromise = client
                .get('/wait')
                .set('Authorization', `Bearer ${joinToken}`);

            await new Promise((resolve) => setTimeout(resolve, 20));

            const resHost = await client
                .post(`/register-and-join/${listenerCode}`);

            const hostToken: string = resHost.body.token;
            expect(resHost.status).toBe(200);
            expect(resHost.body.role).toBe('host');

            const systemWaitRes = await systemWaitPromise;
            expect(systemWaitRes.status).toBe(200);
            expect(systemWaitRes.text).toContain('MESSAGE_RECEIVED');
            expect(systemWaitRes.text).toContain('[SYSTEM]: HOST');

            const messageWaitPromise = client
                .get('/wait')
                .set('Authorization', `Bearer ${joinToken}`);

            await new Promise((resolve) => setTimeout(resolve, 20));

            const sendRes = await client
                .post('/send')
                .set('Authorization', `Bearer ${hostToken}`)
                .set('Content-Type', 'text/plain')
                .send('Listener follow-up [OVER]');

            expect(sendRes.status).toBe(200);
            expect(sendRes.text).toBe('DELIVERED');

            const messageWaitRes = await messageWaitPromise;
            expect(messageWaitRes.status).toBe(200);
            expect(messageWaitRes.text).toContain('Listener follow-up');
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    });
});
