import { startCommandProcessor } from '@lazyapps/command-processor';
import { startReadModels } from '@lazyapps/readmodels';
import { getLogger, configureOtel } from '@lazyapps/logger';
import { trace, context } from '@opentelemetry/api';

const tracer = trace.getTracer('@lazyapps/bootstrap');

const log = getLogger('BS', 'INIT');

let signalHandlersInstalled = false;
let shutdownOtel = () => Promise.resolve();

const handleSignals = (server) => {
  const handler = (signal) => {
    log.info(`Signal ${signal} received`);
    // Force exit after 5s in case graceful shutdown hangs
    setTimeout(() => {
      log.warn('Forced exit after timeout');
      process.exit(1);
    }, 5000).unref();
    shutdownOtel()
      .catch(() => {})
      .then(() => {
        server.close(() => {
          log.info('Server closed, exiting process');
          process.exit(0);
        });
      });
  };

  if (!signalHandlersInstalled) {
    // Let's just do this once per process, since it's possible we're in a monolith
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
    signalHandlersInstalled = true;
  }
};

const initObservability = (observability) =>
  observability
    ? import('@lazyapps/observability')
        .then(({ initialize, shutdown }) => {
          initialize(observability);
          shutdownOtel = shutdown;
        })
        .then(() => import('@opentelemetry/api-logs'))
        .then(({ logs, SeverityNumber }) => {
          configureOtel({ logs, SeverityNumber, trace, context });
        })
    : Promise.resolve();

export function start({
  correlation: correlationConfig,
  observability,
  commands,
  readModels,
  changeNotifier,
  svelte,
}) {
  initObservability(observability).then(() => {
    const startSpan = tracer.startSpan('lazyapps.bootstrap.start', {
      attributes: {
        'bootstrap.observability': !!observability,
        'bootstrap.commands': !!commands,
        'bootstrap.readModels': !!readModels,
        'bootstrap.changeNotifier': !!changeNotifier,
        'bootstrap.svelte': !!svelte,
      },
    });

    if (commands) {
      log.debug('Starting command processor');
      startCommandProcessor(correlationConfig, commands).then((server) => {
        handleSignals(server);
      });
    }
    if (readModels) {
      log.debug('Starting read models');
      startReadModels(correlationConfig, readModels).then((server) => {
        handleSignals(server);
      });
    }
    if (changeNotifier) {
      log.debug('Starting change notifier');
      changeNotifier.listener(correlationConfig).then((server) => {
        handleSignals(server);
      });
    }
    if (svelte) {
      log.debug('Starting SvelteKit frontend');
      import('./svelte.js').then(({ startSvelteKit }) => {
        startSvelteKit(correlationConfig, svelte);
      });
    }

    startSpan.end();
  });
}
