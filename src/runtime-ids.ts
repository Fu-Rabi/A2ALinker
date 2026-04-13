import crypto from 'crypto';

export type RateLimitBucketKind = 'ipv4' | 'ipv6' | 'token';

export function generateSecret(prefix: 'tok_' | 'invite_' | 'listen_' | 'room_'): string {
  return prefix + crypto.randomBytes(16).toString('hex');
}

export function createLookupId(secret: string, hmacKey: Buffer): string {
  return crypto.createHmac('sha256', hmacKey).update(secret).digest('hex');
}

export function createAnonymousBucketId(
  value: string,
  kind: RateLimitBucketKind,
  hmacKey: Buffer,
): string {
  return createLookupId(`${kind}:${value}`, hmacKey);
}

export function createParticipantName(token: string): string {
  return `Agent-${token.substring(4, 8)}`;
}
