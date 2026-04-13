import { EventEmitter } from 'events';
import { createClient, RedisClientType } from 'redis';
import { RuntimeConfig } from './config';
import { logger, PrivacyLogger } from './logger';

export type WakeEvent = {
  recipientLookupId: string;
};

export interface WakeBus {
  start(handler: (event: WakeEvent) => Promise<void> | void): Promise<void>;
  publish(event: WakeEvent): Promise<void>;
  close(): Promise<void>;
}

export class MemoryWakeBus implements WakeBus {
  private readonly emitter = new EventEmitter();

  public async start(handler: (event: WakeEvent) => Promise<void> | void): Promise<void> {
    this.emitter.on('wake', (event: WakeEvent) => {
      void handler(event);
    });
  }

  public async publish(event: WakeEvent): Promise<void> {
    this.emitter.emit('wake', event);
  }

  public async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

export class RedisWakeBus implements WakeBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly channel: string;
  private readonly runtimeLogger: PrivacyLogger;

  public constructor(config: RuntimeConfig, runtimeLogger: PrivacyLogger = logger) {
    if (!config.redisUrl) {
      throw new Error('REDIS_URL is required for RedisWakeBus');
    }

    this.publisher = createClient({ url: config.redisUrl });
    this.subscriber = createClient({ url: config.redisUrl });
    this.channel = 'a2a:wake';
    this.runtimeLogger = runtimeLogger;
  }

  public async start(handler: (event: WakeEvent) => Promise<void> | void): Promise<void> {
    await this.publisher.connect();
    await this.subscriber.connect();
    this.runtimeLogger.info('redis_connected', { component: 'wake_bus' });
    await this.subscriber.subscribe(this.channel, (payload) => {
      const event = JSON.parse(payload) as WakeEvent;
      void handler(event);
    });
  }

  public async publish(event: WakeEvent): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(event));
  }

  public async close(): Promise<void> {
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
    this.runtimeLogger.info('redis_disconnected', { component: 'wake_bus' });
  }
}
