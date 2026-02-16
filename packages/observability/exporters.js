import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const createOtlpConfig = (config) => ({
  url: config.otlp.endpoint,
  timeoutMillis: 5000,
});

export const createExporters = (config) => {
  if (!config.otlp.endpoint) {
    return { trace: undefined, metrics: undefined, logs: undefined };
  }

  const otlpConfig = createOtlpConfig(config);

  return {
    trace: config.traces ? new OTLPTraceExporter(otlpConfig) : undefined,
    metrics: config.metrics
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(otlpConfig),
          exportIntervalMillis: 15000,
        })
      : undefined,
    logs: config.logs ? new OTLPLogExporter(otlpConfig) : undefined,
  };
};

export const __testing__ = { createOtlpConfig };
