import { startCommandProcessor } from '@lazyapps/command-processor';
import { startReadModels } from '@lazyapps/readmodels';
import { getLogger } from '@lazyapps/logger';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('@lazyapps/bootstrap');

const log = getLogger('BS', 'INIT');

let signalHandlersInstalled = false;

const handleSignals = (server) => {
  const handler = (signal) => {
    log.info(`Signal ${signal} received`);
    // Force exit after 5s in case graceful shutdown hangs
    setTimeout(() => {
      log.warn('Forced exit after timeout');
      process.exit(1);
    }, 5000).unref();
    import('@lazyapps/observability')
      .then(({ shutdown }) => shutdown())
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

export function start({
  correlation: correlationConfig,
  commands,
  readModels,
  changeNotifier,
  svelte,
  admin,
}) {
  const startSpan = tracer.startSpan('lazyapps.bootstrap.start', {
    attributes: {
      'bootstrap.commands': !!commands,
      'bootstrap.readModels': !!readModels,
      'bootstrap.changeNotifier': !!changeNotifier,
      'bootstrap.svelte': !!svelte,
      'bootstrap.admin': !!admin,
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
    // When admin is configured, enable lifecycle management for read models
    const readModelConfig = admin
      ? { ...readModels, lifecycle: readModels.lifecycle !== false }
      : readModels;
    startReadModels(correlationConfig, readModelConfig).then((result) => {
      handleSignals(result);
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
  if (admin) {
    log.debug('Starting admin service');
    import('./admin.js').then(({ startAdmin }) => {
      startAdmin(correlationConfig, admin).then((server) => {
        handleSignals(server);
      });
    });
  }

  startSpan.end();
}
