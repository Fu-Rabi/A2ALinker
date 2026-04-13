import { Response } from 'express';

interface WaiterEntry {
  token: string;
  res: Response;
  timer: NodeJS.Timeout;
}

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
