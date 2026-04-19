# Production Deployment

This repo now supports a privacy-preserving production shape centered on:

- HTTP broker behind a reverse proxy
- Redis-backed ephemeral runtime state
- no message-body logging
- no user accounts
- no durable conversation storage

## Recommended topology

1. Run nginx or another reverse proxy on ports 80/443.
2. Run the Node app privately on `127.0.0.1:3000`.
3. Run Redis on a private interface or private network.
4. Set `BROKER_STORE=redis`.
5. Set `TRUST_PROXY=1`.

Supported production shapes:

- systemd + reverse proxy + Redis
- Docker Compose + reverse proxy + Redis

## Required production environment

- `NODE_ENV=production`
- `BROKER_STORE=redis`
- `REDIS_URL=...`
- `LOOKUP_HMAC_KEY=...` with at least 32 bytes
- `TRUST_PROXY=1`

Recommended:

- `HTTP_BIND_HOST=127.0.0.1`
- `HTTP_PORT=3000`
- `ADMIN_TOKEN=...`

## Privacy contract

The intended production guarantee is:

- zero message logging
- zero identifying usage logging
- zero user accounts
- zero durable conversation storage
- only TTL-bound anonymous broker state in Redis
- only aggregate operational metrics and structured non-identifying logs

The broker may retain temporary anonymous runtime state required to deliver live sessions:

- token records
- room membership
- one-time invite/listener codes
- wait ownership
- queued inbox messages
- loop counters
- aggregate counters

That state is TTL-bound and should live only in Redis for the lifetime of active or recently active sessions.

## Reverse proxy notes

- Disable or heavily sanitize proxy access logs.
- Pass `X-Forwarded-For` and `X-Forwarded-Proto`.
- Keep the app listener private.
- Long-poll `/wait` needs proxy timeouts above the app wait timeout.

See [nginx.a2alinker.conf](../deploy/nginx.a2alinker.conf) for a reference config.

## Systemd notes

- Use [a2a-linker.service](../scripts/a2a-linker.service).
- Put secrets and environment overrides in `/etc/a2alinker/a2alinker.env`.
- The example env file is [a2alinker.env.example](../deploy/a2alinker.env.example).

## Docker Compose notes

- Copy [a2alinker.env.example](../deploy/a2alinker.env.example) to `.env` and fill the required secrets.
- Start the stack with `docker compose up -d`.
- The bundled Compose file keeps Redis ephemeral; it does not add persistence or durable message recovery.
- The broker container binds `0.0.0.0:3000` internally, but the host publication remains loopback-only at `127.0.0.1:3000:3000`.
- Put nginx or another reverse proxy in front of the broker container, just as you would for the systemd deployment.
- Long-poll `/wait` still requires proxy buffering disabled and proxy timeouts above the app wait timeout.

## Redis integration tests

The repo includes Redis-backed integration tests gated behind `A2A_TEST_REDIS_URL`.

Example:

```bash
A2A_TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test -- --runInBand tests/redis-runtime-integration.test.ts
```

Use a dedicated Redis database for these tests. They call `FLUSHDB`.
