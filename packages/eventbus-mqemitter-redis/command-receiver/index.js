import pRetry from 'p-retry';

import { getLogger } from '@lazyapps/logger';
import { connect } from '../connect.js';

// NOTE NOTE OLD COMMENT -- may not need this anymore with
// different other mq systems.
//
// For all kinds of reasons (http://zguide.zeromq.org/page:all),
// zeromq pub/sub subscribers can be running behind the publisher
// a bit. This can happen when the subscriber is already running
// before the publisher, but even if it is started shortly after
// the publisher. Of course there are ways to resolve this and
// sync things up "properly", but using zeromq in this sample
// solution is only a suggestion and the issues and solutions
// would be very different with other messaging systems, so I'm
// choosing the simple workaround of a small built-in startup
// delay for now.
const waitSubscribers =
  (log, millis) =>
  (...args) =>
    new Promise((resolve) => {
      log.debug('Waiting for subscribers to catch up');
      setTimeout(() => resolve(...args), millis);
    });

export const mqEmitterRedis =
  ({ host = '127.0.0.1', port = 6379 } = {}) =>
  () => {
    const initLog = getLogger('CP/EB/Redis', 'INIT');

    return pRetry(() => connect({ host, port }), {
      onFailedAttempt: (error) => {
        initLog.error(
          `Attempt ${error.attemptNumber} failed connecting to Redis on port ${port}: '${error}'. Will retry another ${error.retriesLeft} times.`,
        );
      },
      retries: 10,
    })
      .catch((err) => {
        initLog.error(`Failed to connect to Redis on port ${port}: ${err}`);
      })
      .then(waitSubscribers(initLog, 1000))
      .then((mq) => {
        initLog.info(`Event bus publishing to port ${port}`);
        return mq;
      })
      .then((mq) => ({
        publishEvent: (correlationId) => (event) => {
          const log = getLogger('CP/EB/Redis', correlationId);
          log.debug(`Publishing event timestamp ${event.timestamp}`);
          mq.emit({ topic: 'events', payload: { correlationId, event } });
          return event;
        },
        publishReplayState: (correlationId) => (state, readModel) => {
          const log = getLogger('CP/EB/Redis', correlationId);
          log.debug(
            `Publishing replay state ${state} for ${readModel || 'global'}`,
          );
          mq.emit({
            topic: '__system',
            payload: {
              correlationId,
              event: {
                type: 'SET_REPLAY_STATE',
                state,
                ...(readModel && { readModel }),
              },
            },
          });
          return state;
        },
        publishReplayEvent:
          (correlationId) => (targetReadModel, event, targetEndpointName) => {
            const log = getLogger('CP/EB/Redis', correlationId);
            log.debug(`Publishing replay event for ${targetReadModel}`);
            mq.emit({
              topic: '__replay',
              payload: {
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              },
            });
          },
        publishCatchupEvent:
          (correlationId) => (targetReadModel, event, targetEndpointName) => {
            const log = getLogger('CP/EB/Redis', correlationId);
            log.debug(`Publishing catch-up event for ${targetReadModel}`);
            mq.emit({
              topic: '__catchup',
              payload: {
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              },
            });
          },
        publishSystemMessage: (correlationId) => (message) => {
          const log = getLogger('CP/EB/Redis', correlationId);
          log.debug(`Publishing system message: ${JSON.stringify(message)}`);
          mq.emit({
            topic: '__system',
            payload: { correlationId, event: message },
          });
        },
        publishAdminInstruction: (correlationId) => (instruction) => {
          const log = getLogger('CP/EB/Redis', correlationId);
          log.debug(
            `Publishing admin instruction: ${JSON.stringify(instruction)}`,
          );
          mq.emit({
            topic: '__admin',
            payload: { correlationId, instruction },
          });
        },
        subscribeSystemMessages: (handler) => {
          mq.on('__system', ({ payload }, cb) => {
            handler(payload.event);
            cb();
          });
        },
        subscribeAdminMessages: (handler) => {
          mq.on('__admin', ({ payload }, cb) => {
            handler(payload.correlationId, payload.instruction);
            cb();
          });
          return Promise.resolve();
        },
        subscribeAdminReply: (replyTopic, handler) => {
          mq.on(replyTopic, ({ payload }, cb) => {
            handler(payload);
            cb();
          });
          return Promise.resolve();
        },
      }));
  };
