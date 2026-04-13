import { Server as SshServer, AuthContext } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import {
  registerUser,
  isValidToken,
  createSecureRoom,
  redeemInvite,
  getPairedRoom,
  pairTokenToRoom,
  destroyToken,
} from './db';
import { globalRoomManager } from './RoomManager';
import { createRuntimeConfig } from './config';
import { app, createHttpRuntime, startHttpServer } from './http-server';
import { logger } from './logger';
import { MemoryBrokerStore } from './memory-broker-store';
import { RedisBrokerStore } from './redis-broker-store';
import { WaiterRegistry } from './waiter-registry';
import { MemoryWakeBus, RedisWakeBus } from './wake-bus';

export { logger, app };

const HOST_KEY_PATH = 'host.key';

async function bootstrap(): Promise<void> {
  const config = createRuntimeConfig();
  const store = config.storeBackend === 'redis'
    ? new RedisBrokerStore(config)
    : new MemoryBrokerStore(config);

  if (store instanceof RedisBrokerStore) {
    await store.connect();
  }

  const wakeBus = config.storeBackend === 'redis'
    ? new RedisWakeBus(config, logger)
    : new MemoryWakeBus();

  const httpRuntime = createHttpRuntime({
    config,
    runtimeLogger: logger,
    store,
    waiters: new WaiterRegistry(),
    wakeBus,
  });

  const httpServer = await startHttpServer(httpRuntime, config, logger);
  let sshServer: SshServer | null = null;

  if (config.enableSsh) {
    sshServer = startSshServer(config.publicHost, config.sshPort);
  } else {
    logger.info('ssh_disabled', { port: config.sshPort });
  }

  const handleSignal = async (): Promise<void> => {
    await httpRuntime.beginDrain();
    await new Promise((resolve) => setTimeout(resolve, config.drainTimeoutMs));
    await Promise.allSettled([
      new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        sshServer?.close(() => resolve());
        if (!sshServer) {
          resolve();
        }
      }),
      httpRuntime.close(),
    ]);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void handleSignal();
  });
  process.on('SIGTERM', () => {
    void handleSignal();
  });
}

function startSshServer(publicHost: string, port: number): SshServer {
  if (!fs.existsSync(HOST_KEY_PATH)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(HOST_KEY_PATH, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  }
  fs.chmodSync(HOST_KEY_PATH, 0o600);

  const activeTokens = new Set<string>();
  const sshRegisterAttempts = new Map<string, { count: number; windowStart: number }>();

  const server = new SshServer({
    hostKeys: [fs.readFileSync(HOST_KEY_PATH)],
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  }, (client) => {
    const clientIp: string =
      (client as { socket?: { remoteAddress?: string }; _sock?: { remoteAddress?: string } }).socket?.remoteAddress ??
      (client as { _sock?: { remoteAddress?: string } })._sock?.remoteAddress ??
      'unknown';
    let authenticatedToken = '';

    client.on('close', () => {
      if (authenticatedToken) {
        activeTokens.delete(authenticatedToken);
        if (!getPairedRoom(authenticatedToken)) {
          destroyToken(authenticatedToken);
        }
      }
    });

    client.on('error', (error: Error & { code?: string }) => {
      if (isExpectedSshClientError(error)) {
        return;
      }

      logger.warn('ssh_client_error', { errorCode: error.code ?? 'unknown' });
    });

    client.on('authentication', (ctx: AuthContext) => {
      const attemptedUsername = ctx.username;

      if (attemptedUsername === 'new') {
        const now = Date.now();
        const entry = sshRegisterAttempts.get(clientIp) ?? { count: 0, windowStart: now };
        if (now - entry.windowStart > 3_600_000) {
          entry.count = 0;
          entry.windowStart = now;
        }
        if (entry.count >= 10) {
          ctx.reject();
          return;
        }
        entry.count += 1;
        sshRegisterAttempts.set(clientIp, entry);
        ctx.accept();
        return;
      }

      if (isValidToken(attemptedUsername)) {
        if (activeTokens.has(attemptedUsername)) {
          ctx.reject();
          return;
        }
        activeTokens.add(attemptedUsername);
        authenticatedToken = attemptedUsername;
        ctx.accept();
        return;
      }

      ctx.reject();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty();
        });

        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          handleCommand(authenticatedToken, info.command.trim(), stream, publicHost);
        });

        session.on('shell', (acceptShell) => {
          const stream = acceptShell();

          if (!authenticatedToken) {
            const token = generateLegacyRegistrationToken();
            registerUser(token);
            logger.info('token_registered');
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

          stream.write(`\r\nUsage:\r\n`);
          stream.write(`  ssh -p 2222 ${authenticatedToken}@${publicHost} create              (host a new session)\r\n`);
          stream.write(`  ssh -p 2222 ${authenticatedToken}@${publicHost} join <invite_code>  (join a session)\r\n\r\n`);
          stream.exit(1);
          stream.end();
        });
      });
    });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('ssh_server_started', { port });
  });

  return server;
}

function generateLegacyRegistrationToken(): string {
  return 'tok_' + crypto.randomBytes(16).toString('hex');
}

function handleCommand(token: string, command: string, stream: NodeJS.WritableStream & {
  write(chunk: string): boolean;
  exit(code: number): void;
  end(): void;
}, publicHost: string): void {
  if (!token) {
    stream.write(`Error: You must register first. Run: ssh -p 2222 new@${publicHost}\r\n`);
    stream.exit(1);
    stream.end();
    return;
  }

  const parts = command.split(/\s+/);
  const action = parts[0]?.toLowerCase();

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
    logger.info('session_created', { sessionType: 'ssh_standard' });

    stream.write(`\r\n╔══════════════════════════════════════════════════╗\r\n`);
    stream.write(`║           A2A Linker — Secure Session             ║\r\n`);
    stream.write(`╚══════════════════════════════════════════════════╝\r\n`);
    stream.write(`\r\n✓ Secure room created!\r\n`);
    stream.write(`\r\n  One-Time Invite Code: ${inviteCode}\r\n`);
    stream.write(`\r\n  Share this code with your partner. It is valid for ONE use only.\r\n`);
    stream.write(`  Their agent should run:\r\n`);
    stream.write(`  ssh -p 2222 <their_token>@${publicHost} join ${inviteCode}\r\n\r\n`);
    stream.write(`Waiting for your partner to join...\r\n`);

    globalRoomManager.joinRoom(internalRoomName, stream as never, `Agent-${token.substring(4, 8)}`);
    return;
  }

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

    const redeemResult = redeemInvite(inviteCode);
    if (!redeemResult) {
      logger.warn('join_attempt_rejected', { endpoint: 'ssh_join' });
      stream.write(`\r\nError: Invite code '${inviteCode}' is invalid or has already been used.\r\n`);
      stream.exit(1);
      stream.end();
      return;
    }
    const { roomName } = redeemResult;

    pairTokenToRoom(token, roomName);
    logger.info('session_joined', { role: 'ssh_joiner' });
    stream.write(`\r\n✓ Invite accepted! Connecting to secure session...\r\n`);
    globalRoomManager.joinRoom(roomName, stream as never, `Agent-${token.substring(4, 8)}`);
    return;
  }

  stream.write(`\r\nUnknown command: ${command}\r\n`);
  stream.write(`Usage:\r\n`);
  stream.write(`  create       — Host a new secure session\r\n`);
  stream.write(`  join <code>  — Join a session with an invite code\r\n\r\n`);
  stream.exit(1);
  stream.end();
}

function isExpectedSshClientError(error: Error & { code?: string }): boolean {
  const expectedCodes = new Set(['ECONNRESET', 'EPIPE']);
  if (error.code && expectedCodes.has(error.code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('connection reset') || message.includes('socket hang up') || message.includes('write after end');
}

void bootstrap();
