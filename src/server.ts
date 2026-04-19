import { createRuntimeConfig } from './config';
import { app, createHttpRuntime, startHttpServer } from './http-server';
import { logger } from './logger';
import { MemoryBrokerStore } from './memory-broker-store';
import { RedisBrokerStore } from './redis-broker-store';
import { WaiterRegistry } from './waiter-registry';
import { MemoryWakeBus, RedisWakeBus } from './wake-bus';

export { logger, app };

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

  const handleSignal = async (): Promise<void> => {
    await httpRuntime.beginDrain();
    await new Promise((resolve) => setTimeout(resolve, config.drainTimeoutMs));
    await Promise.allSettled([
      new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
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

void bootstrap();
