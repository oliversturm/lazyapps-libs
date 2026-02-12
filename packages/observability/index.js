import { NodeSDK } from '@opentelemetry/sdk-node';
import { createConfig } from './config.js';
import { createResource } from './resource.js';
import { createExporters } from './exporters.js';

export { createConfig } from './config.js';
export { createResource } from './resource.js';
export { createExporters } from './exporters.js';

let initialized = false;
let sdkInstance = null;

export const isInitialized = () => initialized;

export const shutdown = () =>
  sdkInstance ? sdkInstance.shutdown() : Promise.resolve();

export const __resetForTesting = () => {
  initialized = false;
  sdkInstance = null;
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
    logRecordExporter: exporters.logs,
    instrumentations: config.instrumentations,
  });

  sdk.start();
  sdkInstance = sdk;

  return sdk;
};
