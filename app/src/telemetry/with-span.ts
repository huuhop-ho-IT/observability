import { HttpException } from '@nestjs/common';
import { Attributes, SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './metrics';

/** Wraps a business step in a child span so Tempo shows exactly which step takes time. */
export function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) {
        // Business rejections (409/404) are not system errors -> don't paint the trace red
        span.setAttribute('booking.rejected', err.message);
      } else {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      }
      throw err;
    } finally {
      span.end();
    }
  });
}
