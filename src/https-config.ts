export const DEFAULT_HTTPS_KEY_PATH = '/etc/letsencrypt/live/broker.a2alinker.net/privkey.pem';
export const DEFAULT_HTTPS_CERT_PATH = '/etc/letsencrypt/live/broker.a2alinker.net/fullchain.pem';

export function resolveHttpsCertPaths(env: NodeJS.ProcessEnv = process.env): {
  keyPath: string;
  certPath: string;
} {
  return {
    keyPath: env.HTTPS_KEY_PATH || DEFAULT_HTTPS_KEY_PATH,
    certPath: env.HTTPS_CERT_PATH || DEFAULT_HTTPS_CERT_PATH,
  };
}
