import { NodeSDK } from '@opentelemetry/sdk-node';
import { logs } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { createConfig } from './config.js';
import { createResource } from './resource.js';
import { createExporters } from './exporters.js';

export { createConfig } from './config.js';
export { createResource } from './resource.js';
export { createExporters } from './exporters.js';

let initialized = false;
let sdkInstance = null;
let loggerProviderInstance = null;

export const isInitialized = () => initialized;
export const getLoggerProvider = () => loggerProviderInstance;

export const shutdown = () =>
  Promise.all([
    sdkInstance ? sdkInstance.shutdown() : Promise.resolve(),
    loggerProviderInstance
      ? loggerProviderInstance.shutdown()
      : Promise.resolve(),
  ]);

export const __resetForTesting = () => {
  initialized = false;
  sdkInstance = null;
  loggerProviderInstance = null;
};

export const initialize = (userConfig) => {
  if (initialized) {
    return;
  }
  initialized = true;

  const config = createConfig(userConfig);
  const resource = createResource(config);
  const exporters = createExporters(config);

  const sdk = new NodeSDK({
    resource,
    traceExporter: exporters.trace,
    metricReader: exporters.metrics,
    instrumentations: config.instrumentations,
  });

  sdk.start();
  sdkInstance = sdk;

  // NodeSDK does not register a global LoggerProvider, so logs.getLogger()
  // returns a NOOP logger by default. We create and register one explicitly.
  if (exporters.logs) {
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(exporters.logs)],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
    loggerProviderInstance = loggerProvider;
  }

  return sdk;
};
