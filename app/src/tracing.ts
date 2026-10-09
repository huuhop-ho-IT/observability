/**
 * OpenTelemetry bootstrap — the app is where telemetry is born.
 *
 * Loaded with `node --require ./dist/tracing.js` so http, express, pg, ioredis, pino...
 * are patched BEFORE NestJS imports them.
 *
 * The app only knows ONE address: OTEL_EXPORTER_OTLP_ENDPOINT (otel-collector:4317).
 * It has no idea whether Prometheus, Tempo or Loki sit behind it.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { AggregationType, InstrumentType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { hostname } from 'os';

// Buckets in seconds: covers both fast rejects (~1ms) and slow DB calls (3s timeout)
const LATENCY_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10];

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'booking-api',
    [ATTR_SERVICE_VERSION]: '1.0.0',
    'service.instance.id': hostname(), // distinguishes the 2 replicas behind nginx
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 5000,
  }),
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  views: [
    {
      instrumentName: 'http.server.request.duration',
      instrumentType: InstrumentType.HISTOGRAM,
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: LATENCY_BUCKETS_SECONDS },
      },
    },
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs/dns/net produce lots of low-value spans for this demo
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // Skip a span per Express middleware (jsonParser, cors...); keep route + Nest controller spans
      '@opentelemetry/instrumentation-express': { ignoreLayersType: [ExpressLayerType.MIDDLEWARE] },
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/metrics',
      },
      // pino: injects trace_id/span_id into every log line AND ships logs via OTLP (-> Collector -> Loki)
      '@opentelemetry/instrumentation-pino': { enabled: true },
    }),
  ],
});

sdk.start();

const shutdown = () => {
  sdk
    .shutdown()
    .catch((err) => console.error('OTel SDK shutdown error', err))
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
