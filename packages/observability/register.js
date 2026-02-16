import { initialize, getLoggerProvider } from './index.js';
import { configureOtel } from '@lazyapps/logger';
import { trace, context } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

initialize();

configureOtel({
  logs,
  SeverityNumber,
  trace,
  context,
  loggerProvider: getLoggerProvider(),
});
