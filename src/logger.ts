export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function shouldLog(level: LogLevel): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  return level === 'warn' || level === 'error';
}

function write(level: LogLevel, ...args: unknown[]): void {
  if (!shouldLog(level)) {
    return;
  }

  if (level === 'warn') {
    console.warn(...args);
    return;
  }

  if (level === 'error') {
    console.error(...args);
    return;
  }

  console.log(...args);
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', ...args),
  info: (...args: unknown[]) => write('info', ...args),
  warn: (...args: unknown[]) => write('warn', ...args),
  error: (...args: unknown[]) => write('error', ...args),
};
