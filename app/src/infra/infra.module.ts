import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [DatabaseService, RedisService],
  exports: [DatabaseService, RedisService],
})
export class InfraModule {}
