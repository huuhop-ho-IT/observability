import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { RedisService } from '../infra/redis.service';

export type ChaosMode = 'none' | 'slow-db' | 'db-timeout';
export interface ChaosConfig {
  mode: ChaosMode;
  ratio: number; // 0..1: share of requests affected
}

const KEY = 'chaos:config';

/**
 * Deliberate fault injection to reproduce the classic incident:
 *   Prometheus: p95 spikes -> Tempo: DB span takes 3s -> Loki: "statement timeout".
 * Config lives in Redis so every replica shares it.
 */
@Injectable()
export class ChaosService {
  private cached: ChaosConfig = { mode: 'none', ratio: 0 };
  private cachedAt = 0;

  constructor(private readonly redisService: RedisService) {}

  async get(): Promise<ChaosConfig> {
    if (Date.now() - this.cachedAt > 1000) {
      const raw = await this.redisService.redis.get(KEY);
      this.cached = raw ? JSON.parse(raw) : { mode: 'none', ratio: 0 };
      this.cachedAt = Date.now();
    }
    return this.cached;
  }

  async set(config: ChaosConfig) {
    await this.redisService.redis.set(KEY, JSON.stringify(config));
    this.cachedAt = 0;
  }

  /** Runs inside the booking transaction. */
  async inject(client: PoolClient) {
    const { mode, ratio } = await this.get();
    if (mode === 'none' || Math.random() >= ratio) return;

    if (mode === 'slow-db') {
      await client.query('SELECT pg_sleep(3)');
    } else if (mode === 'db-timeout') {
      await client.query(`SET LOCAL statement_timeout = '1000ms'`);
      await client.query('SELECT pg_sleep(3)'); // -> "canceling statement due to statement timeout"
    }
  }
}
