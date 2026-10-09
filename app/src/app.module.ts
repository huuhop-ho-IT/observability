import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { BookingController } from './booking/booking.controller';
import { BookingService } from './booking/booking.service';
import { ChaosController } from './chaos/chaos.controller';
import { ChaosService } from './chaos/chaos.service';
import { HealthController } from './health.controller';
import { InfraModule } from './infra/infra.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // JSON logs to stdout; instrumentation-pino adds trace_id/span_id
        // and also ships each log record via OTLP -> Collector -> Loki.
        autoLogging: { ignore: (req) => req.url === '/health' },
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
        // Mask sensitive data in the app (the Collector adds a second layer)
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    InfraModule,
  ],
  controllers: [BookingController, ChaosController, HealthController],
  providers: [BookingService, ChaosService],
})
export class AppModule {}
