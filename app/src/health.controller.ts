import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './infra/database.service';
import { RedisService } from './infra/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  async check() {
    await this.db.query('SELECT 1');
    await this.redisService.redis.ping();
    return { status: 'ok' };
  }
}
