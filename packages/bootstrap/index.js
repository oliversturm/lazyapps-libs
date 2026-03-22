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

const MIXIN_COMMANDS = ['FORGET_SUBJECT', 'FORGET_SUBJECT_CONTEXT'];

const MIXIN_PROJECTIONS = ['SUBJECT_FORGOTTEN'];

const checkConflicts = (aggregateName, aggregate) => {
  const conflicts = [];
  for (const cmd of MIXIN_COMMANDS) {
    if (aggregate.commands && aggregate.commands[cmd]) {
      conflicts.push(`command ${cmd}`);
    }
  }
  for (const proj of MIXIN_PROJECTIONS) {
    if (aggregate.projections && aggregate.projections[proj]) {
      conflicts.push(`projection ${proj}`);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Aggregate '${aggregateName}' already defines ` +
        `${conflicts.join(', ')}. ` +
        'Application-level override of framework-injected forget ' +
        'handlers is not supported.',
    );
  }
};

const injectForgetMixin = (aggregates, subjects, mixin) => {
  if (!subjects || !aggregates) return aggregates;

  const result = { ...aggregates };
  for (const aggregateName of Object.keys(subjects)) {
    const aggregate = result[aggregateName];
    if (!aggregate) {
      log.warn(
        `Encryption subjects config references aggregate ` +
          `'${aggregateName}' but it is not registered`,
      );
      continue;
    }
    checkConflicts(aggregateName, aggregate);
    result[aggregateName] = {
      ...aggregate,
      commands: {
        ...aggregate.commands,
        ...mixin.commands,
      },
      projections: {
        ...aggregate.projections,
        ...mixin.projections,
      },
    };
    log.info(`Injected forget mixin into aggregate '${aggregateName}'`);
  }
  return result;
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
            aggregates:
              enc.getSubjects && enc.getSubjects() && commands.aggregates
                ? injectForgetMixin(
                    commands.aggregates,
                    enc.getSubjects(),
                    enc.createForgetMixin(),
                  )
                : commands.aggregates,
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
            encryptionForgetSubject: enc.forgetSubject,
            encryptionForgetSubjectContext: enc.forgetSubjectContext,
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
