import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsNumber, Max, Min } from 'class-validator';
import { ChaosMode, ChaosService } from './chaos.service';

class ChaosDto {
  @IsIn(['none', 'slow-db', 'db-timeout'])
  mode: ChaosMode;

  @IsNumber()
  @Min(0)
  @Max(1)
  ratio: number = 1;
}

@Controller('api/chaos')
export class ChaosController {
  constructor(private readonly chaos: ChaosService) {}

  @Get()
  get() {
    return this.chaos.get();
  }

  @Post()
  async set(@Body() dto: ChaosDto) {
    await this.chaos.set({ mode: dto.mode, ratio: dto.ratio });
    return { ok: true, ...dto };
  }
}
