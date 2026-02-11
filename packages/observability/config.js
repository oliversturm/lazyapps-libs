import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';

const defaults = {
  serviceName: 'unknown-service',
  serviceVersion: undefined,
  environment: undefined,
  otlp: {
    endpoint: 'http://localhost:4317',
    protocol: 'grpc',
    insecure: true,
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

const createInstrumentations = () => [
  new HttpInstrumentation(),
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
  instrumentations: userConfig.instrumentations || createInstrumentations(),
});

export const __testing__ = { defaults, createInstrumentations };
