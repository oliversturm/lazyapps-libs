import { getLogger } from '@lazyapps/logger';
import { AuthorizationError } from './validation.js';

export const handleAdminCommand =
  (isAdmin) => (context, command, params, auth, correlationId) => {
    const log = getLogger('CP/AdHandler', correlationId);
    if (!isAdmin) {
      log.error('Admin command rejected: no isAdmin callback configured');
      return Promise.reject(
        new AuthorizationError('Admin access is not configured'),
      );
    }
    if (!isAdmin(auth)) {
      log.error('Admin command rejected: unauthorized');
      return Promise.reject(new AuthorizationError('Admin role required'));
    }

    if (command !== 'setReplayState') {
      log.error(`Invalid admin command ${command}`);
      return Promise.reject(new Error(`Invalid admin command ${command}`));
    }

    if (!params || typeof params.state !== 'boolean') {
      log.error(`Invalid replay state ${params.state}`);
      return Promise.reject(new Error(`Invalid replay state ${params.state}`));
    }

    const { eventBus } = context;
    if (!eventBus) {
      log.error(`Event bus not found`);
      return Promise.reject(new Error(`Event bus not found`));
    }

    // Trying to remember why, but this call is synchronous
    return new Promise((resolve) => {
      resolve(eventBus.publishReplayState(correlationId)(params.state));
    });
  };
