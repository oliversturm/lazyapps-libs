import { getLogger } from '@lazyapps/logger';
import { createContextQueue } from './contextQueue.js';

const createSideEffectsHandler = () => {
  const queue = createContextQueue(1, Infinity);

  const schedule =
    (correlationId, inReplay) =>
    (promiseGenerator, options = {}) => {
      const defaultOptions = { name: 'unnamed' };
      const actualOptions = { ...defaultOptions, ...options };

      const log = getLogger('ReadMod/Side', correlationId);
      return inReplay
        ? new Promise((resolve) => {
            log.debug(
              `Skipping side-effect '${actualOptions.name}' (inReplay=${inReplay})`,
            );
            resolve();
          })
        : queue.add(() =>
            new Promise((resolve) => {
              log.debug(
                `Running side-effect '${actualOptions.name}' (inReplay=${inReplay})`,
              );
              resolve();
            })
              .then(promiseGenerator())
              .then(
                () =>
                  new Promise((resolve) => {
                    log.debug(`Side-effect '${actualOptions.name}' done`);
                    resolve();
                  }),
              )
              .catch((err) => {
                log.error(
                  `Can't execute side-effect '${actualOptions.name}': ${err}`,
                );
              }),
          );
    };

  return Promise.resolve({
    getSideEffectsHandler: (correlationId, inReplay) => ({
      schedule: schedule(correlationId, inReplay),
    }),
  });
};

export { createSideEffectsHandler };
