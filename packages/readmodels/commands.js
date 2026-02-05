import { getLogger } from '@lazyapps/logger';

const createCommandHandler =
  ({ commandSender }) =>
  (correlationId) => {
    const log = getLogger('RM/Cmd', correlationId);
    return {
      // accept the command parameters and then return a promise generator
      // which will be evaluated lazily depending on replay state
      execute: (cmd) => () =>
        new Promise((resolve) => {
          log.debug(`Executing command ${JSON.stringify(cmd)}`);
          resolve();
        })
          .then(() => commandSender.sendCommand(correlationId, cmd))
          .catch((err) => {
            log.error(`Can't execute command ${JSON.stringify(cmd)}: ${err}`);
          }),
    };
  };
export { createCommandHandler };
