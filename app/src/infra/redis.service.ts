import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock from 'redlock';

/**
 * - `redis`: seat-status cache + remaining-seat counter (fast reject without touching the DB).
 * - `redlock`: distributed per-seat lock. REDLOCK_NODES may list several independent Redis
 *   nodes (>= 3 recommended in production); the demo uses a single node for simplicity.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: 3,
  });

  private readonly lockNodes = (process.env.REDLOCK_NODES ?? process.env.REDIS_URL ?? 'redis://redis:6379')
    .split(',')
    .map((url) => new Redis(url.trim(), { maxRetriesPerRequest: 3 }));

  readonly redlock = new Redlock(this.lockNodes, {
    driftFactor: 0.01,
    // Seat held by someone else -> retry a few times, then give up (409)
    retryCount: Number(process.env.LOCK_RETRY_COUNT ?? 3),
    retryDelay: Number(process.env.LOCK_RETRY_DELAY_MS ?? 100),
    retryJitter: 50,
    automaticExtensionThreshold: 500,
  });

  async onModuleDestroy() {
    await Promise.all([this.redis.quit(), ...this.lockNodes.map((n) => n.quit())]);
  }
}
