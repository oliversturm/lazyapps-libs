import { startCommandProcessor } from '@lazyapps/command-processor';
import { startReadModels } from '@lazyapps/readmodels';
import { getLogger } from '@lazyapps/logger';
import { trace, context } from '@opentelemetry/api';

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

const startSubsystems = (
  correlationConfig,
  commands,
  readModels,
  changeNotifier,
  svelte,
  startSpan,
) => {
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
};

export function start({
  correlation: correlationConfig,
  encryption,
  commands,
  readModels,
  changeNotifier,
  svelte,
}) {
  const startSpan = tracer.startSpan('lazyapps.bootstrap.start', {
    attributes: {
      'bootstrap.commands': !!commands,
      'bootstrap.readModels': !!readModels,
      'bootstrap.changeNotifier': !!changeNotifier,
      'bootstrap.svelte': !!svelte,
    },
  });

  if (encryption) {
    const encryptionReady = encryption.then
      ? encryption
      : Promise.resolve(encryption);

    encryptionReady.then((enc) => {
      const effectiveCommands = commands
        ? {
            ...commands,
            eventStore: enc.wrapEventStore(commands.eventStore),
            eventBus: enc.wrapEventBus(commands.eventBus),
          }
        : commands;
      const effectiveReadModels = readModels
        ? {
            ...readModels,
            encryptionDecryptor: enc.createProjectionDecryptor(
              readModels.role || 'service',
            ),
            storage: enc.wrapStorage(readModels.storage),
            encryptionQueryDecryptor: enc.createQueryDecryptor(),
          }
        : readModels;
      startSubsystems(
        correlationConfig,
        effectiveCommands,
        effectiveReadModels,
        changeNotifier,
        svelte,
        startSpan,
      );
    });
  } else {
    startSubsystems(
      correlationConfig,
      commands,
      readModels,
      changeNotifier,
      svelte,
      startSpan,
    );
  }
}
