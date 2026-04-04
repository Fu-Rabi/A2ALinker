import { Server, AuthContext } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import { registerUser, isValidToken, createSecureRoom, redeemInvite, getPairedRoom, pairTokenToRoom, destroyToken } from './db';
import { globalRoomManager } from './RoomManager';
import { startHttpServer } from './http-server';

// Safe logger that mutes on 'production'
export const logger = {
    log: (...args: any[]) => process.env.NODE_ENV !== 'production' && console.log(...args),
    error: (...args: any[]) => process.env.NODE_ENV !== 'production' && console.error(...args),
};

// Generate Host Key if missing (required for SSH)
const HOST_KEY_PATH = 'host.key';
const publicHost = process.env.PUBLIC_HOST || 'localhost';

if (!fs.existsSync(HOST_KEY_PATH)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(HOST_KEY_PATH, privateKey.export({ type: 'pkcs1', format: 'pem' }));
}
fs.chmodSync(HOST_KEY_PATH, 0o600);

const activeTokens = new Set<string>();

export const server = new Server({
    hostKeys: [fs.readFileSync(HOST_KEY_PATH)],
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
}, (client) => {
    let authenticatedToken = '';
    
    // Use 'close' (not 'end') — 'close' fires on both clean disconnects AND hard
    // network drops. 'end' only fires for graceful TCP FIN, so a crashed agent
    // would permanently lock its token in activeTokens for the process lifetime.
    client.on('close', () => {
        if (authenticatedToken) {
            activeTokens.delete(authenticatedToken);
            // Destroy un-paired tokens to leave no trace
            if (!getPairedRoom(authenticatedToken)) {
                destroyToken(authenticatedToken);
            }
        }
    });

    client.on('error', () => {}); // Handle connection drops gracefully

    client.on('authentication', (ctx: AuthContext) => {
        const attemptedUsername = ctx.username;
        
        // Registration Flow: username = "new"
        if (attemptedUsername === 'new') {
            return ctx.accept();
        }

        // Standard auth: username is the token
        if (isValidToken(attemptedUsername)) {
            if (activeTokens.has(attemptedUsername)) {
                return ctx.reject(); // Prevent concurrent session with the same token
            }
            activeTokens.add(attemptedUsername);
            authenticatedToken = attemptedUsername;
            return ctx.accept();
        } else {
            return ctx.reject();
        }
    });

    client.on('ready', () => {
        client.on('session', (accept, _reject) => {
            const session = accept();

            session.on('pty', (accept, _reject, _info) => {
                accept();
            });

            // Handle commands e.g., `ssh token@host create` or `ssh token@host join invite_xxx`
            session.on('exec', (accept, _reject, info) => {
                const stream = accept();
                const command = info.command.trim();
                handleCommand(authenticatedToken, command, stream);
            });

            // Handle plain shell `ssh token@host` (no command)
            session.on('shell', (accept, _reject) => {
                const stream = accept();

                if (!authenticatedToken) {
                    // Registration mode
                    const token = 'tok_' + crypto.randomBytes(6).toString('hex');
                    logger.log(`[A2ALinker:Server] Generated new registration token: ${token}`);
                    registerUser(token);
                    stream.write(`\r\n╔══════════════════════════════════════════╗\r\n`);
                    stream.write(`║         A2A Linker — Registration         ║\r\n`);
                    stream.write(`╚══════════════════════════════════════════╝\r\n`);
                    stream.write(`\r\nYour Account Token: ${token}\r\n\r\n`);
                    stream.write(`• To host a session:\r\n`);
                    stream.write(`  ssh -p 2222 ${token}@${publicHost} create\r\n\r\n`);
                    stream.write(`• To join a session:\r\n`);
                    stream.write(`  ssh -p 2222 ${token}@${publicHost} join <invite_code>\r\n\r\n`);
                    stream.exit(0);
                    stream.end();
                    return;
                }

                // Valid token but no command
                stream.write(`\r\nUsage:\r\n`);
                stream.write(`  ssh -p 2222 ${authenticatedToken}@${publicHost} create              (host a new session)\r\n`);
                stream.write(`  ssh -p 2222 ${authenticatedToken}@${publicHost} join <invite_code>  (join a session)\r\n\r\n`);
                stream.exit(1);
                stream.end();
            });
        });
    });
});

function handleCommand(token: string, command: string, stream: any) {
    if (!token) {
        stream.write(`Error: You must register first. Run: ssh -p 2222 new@${publicHost}\r\n`);
        stream.exit(1);
        stream.end();
        return;
    }

    const parts = command.split(/\s+/);
    const action = parts[0]?.toLowerCase();

    // === CREATE command ===
    if (action === 'create') {
        if (getPairedRoom(token)) {
             stream.write(`\r\nError: This token is already strictly paired to a session. Generate a new token.\r\n`);
             stream.exit(1);
             stream.end();
             return;
        }

        const result = createSecureRoom(token);
        if (!result) {
            stream.write(`\r\nError: Maximum limit reached for this account or creation failed.\r\n`);
            stream.exit(1);
            stream.end();
            return;
        }

        const { inviteCode, internalRoomName } = result;
        pairTokenToRoom(token, internalRoomName);
        logger.log(`[A2ALinker:Server] Token '${token}' created and strictly paired to room '${internalRoomName}' with invite '${inviteCode}'`);

        stream.write(`\r\n╔══════════════════════════════════════════════════╗\r\n`);
        stream.write(`║           A2A Linker — Secure Session             ║\r\n`);
        stream.write(`╚══════════════════════════════════════════════════╝\r\n`);
        stream.write(`\r\n✓ Secure room created!\r\n`);
        stream.write(`\r\n  One-Time Invite Code: ${inviteCode}\r\n`);
        stream.write(`\r\n  Share this code with your partner. It is valid for ONE use only.\r\n`);
        stream.write(`  Their agent should run:\r\n`);
        stream.write(`  ssh -p 2222 <their_token>@${publicHost} join ${inviteCode}\r\n\r\n`);
        stream.write(`Waiting for your partner to join...\r\n`);

        // Now drop into the room
        globalRoomManager.joinRoom(internalRoomName, stream, `Agent-${token.substring(4, 8)}`);
        return;
    }

    // === JOIN command ===
    if (action === 'join') {
        if (getPairedRoom(token)) {
             stream.write(`\r\nError: This token is already strictly paired to a session. Generate a new token.\r\n`);
             stream.exit(1);
             stream.end();
             return;
        }

        const inviteCode = parts[1];
        if (!inviteCode) {
            stream.write(`\r\nError: Invite code required. Usage: ssh -p 2222 <token>@${publicHost} join <invite_code>\r\n`);
            stream.exit(1);
            stream.end();
            return;
        }

        const roomName = redeemInvite(inviteCode);
        if (!roomName) {
            logger.error(`[A2ALinker:Server] Token '${token}' tried invalid/expired invite '${inviteCode}'`);
            stream.write(`\r\nError: Invite code '${inviteCode}' is invalid or has already been used.\r\n`);
            stream.exit(1);
            stream.end();
            return;
        }

        pairTokenToRoom(token, roomName);
        logger.log(`[A2ALinker:Server] Token '${token}' redeemed invite '${inviteCode}' and strictly paired to room '${roomName}'`);
        stream.write(`\r\n✓ Invite accepted! Connecting to secure session...\r\n`);
        globalRoomManager.joinRoom(roomName, stream, `Agent-${token.substring(4, 8)}`);
        return;
    }

    stream.write(`\r\nUnknown command: ${command}\r\n`);
    stream.write(`Usage:\r\n`);
    stream.write(`  create       — Host a new secure session\r\n`);
    stream.write(`  join <code>  — Join a session with an invite code\r\n\r\n`);
    stream.exit(1);
    stream.end();
}

const PORT = parseInt(process.env.PORT || '2222', 10);
server.listen(PORT, '0.0.0.0', () => {
    logger.log(`[A2ALinker] Secure Broker SSH running on port ${PORT}`);
});

startHttpServer();
