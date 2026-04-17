import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';

const defaults = {
  serviceName: undefined,
  serviceNamespace: undefined,
  serviceVersion: undefined,
  environment: undefined,
  otlp: {
    endpoint: undefined,
    protocol: undefined,
    insecure: false,
  },
  traces: true,
  metrics: true,
  logs: true,
  sampler: {
    type: 'always_on',
    ratio: 1.0,
  },
  diagnosticLogLevel: 'WARN',
};

const createInstrumentations = (config = {}) => [
  new HttpInstrumentation(config.httpInstrumentation || {}),
  new ExpressInstrumentation(),
  new MongoDBInstrumentation(),
  new AmqplibInstrumentation(),
  new SocketIoInstrumentation(),
];

export const createConfig = (userConfig = {}) => ({
  ...defaults,
  ...userConfig,
  otlp: {
    ...defaults.otlp,
    ...(userConfig.otlp || {}),
  },
  sampler: {
    ...defaults.sampler,
    ...(userConfig.sampler || {}),
  },
  instrumentations:
    userConfig.instrumentations || createInstrumentations(userConfig),
});

export const __testing__ = { defaults, createInstrumentations };
