import { Response } from 'express';

interface WaiterEntry {
  token: string;
  res: Response;
  timer: NodeJS.Timeout;
}

export type WaiterResolveStatus = 'resolved' | 'stale' | 'missing';

export class WaiterRegistry {
  private readonly waiters = new Map<string, WaiterEntry>();

  public has(waiterKey: string): boolean {
    return this.waiters.has(waiterKey);
  }

  public register(waiterKey: string, entry: WaiterEntry): boolean {
    if (this.waiters.has(waiterKey)) {
      return false;
    }

    this.waiters.set(waiterKey, entry);
    return true;
  }

  public getToken(waiterKey: string): string | null {
    return this.waiters.get(waiterKey)?.token ?? null;
  }

  public resolve(waiterKey: string, text: string): boolean {
    const entry = this.waiters.get(waiterKey);
    if (!entry) {
      return false;
    }

    clearTimeout(entry.timer);
    this.waiters.delete(waiterKey);
    entry.res.send(text);
    return true;
  }

  public resolveIfActive(waiterKey: string, text: string): WaiterResolveStatus {
    const entry = this.waiters.get(waiterKey);
    if (!entry) {
      return 'missing';
    }

    const req = (entry.res as Response & { req?: { aborted?: boolean; destroyed?: boolean } }).req;
    if (entry.res.destroyed || entry.res.writableEnded || req?.aborted || req?.destroyed) {
      clearTimeout(entry.timer);
      this.waiters.delete(waiterKey);
      return 'stale';
    }

    clearTimeout(entry.timer);
    this.waiters.delete(waiterKey);
    entry.res.send(text);
    return 'resolved';
  }

  public clear(waiterKey: string): void {
    const entry = this.waiters.get(waiterKey);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.waiters.delete(waiterKey);
  }

  public size(): number {
    return this.waiters.size;
  }

  public keys(): string[] {
    return [...this.waiters.keys()];
  }

  public resolveAll(text: string): string[] {
    const resolved: string[] = [];
    for (const waiterKey of this.keys()) {
      const token = this.getToken(waiterKey);
      if (token && this.resolve(waiterKey, text)) {
        resolved.push(token);
      }
    }

    return resolved;
  }
}
