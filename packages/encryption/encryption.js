import { createFieldEncryptor } from './fieldEncryption.js';
import { createEnvelopeManager } from './envelopeEncryption.js';
import { createKeyCache } from './keyCache.js';
import { createFallbackHandler } from './fallback.js';
import { createStorageEncryptor } from './storageEncryption.js';
import { createQueryDecryptor as createQueryDecryptorImpl } from './queryDecryptor.js';
import { createForgetMixin as createForgetMixinImpl } from './forgetMixin.js';
import { getLogger } from '@lazyapps/logger';

export const createEncryption = ({
  schema,
  keyStore,
  contexts,
  subjects,
  readModelEncryption,
  cache = { maxSize: 10000, ttlMs: 300000 },
  authorizeForget,
}) => {
  const log = getLogger('Encryption', 'INIT');

  return keyStore
    .initialize()
    .then((ks) => createKeyCache(ks, cache))
    .then((cachedKs) => {
      const envelope = createEnvelopeManager(cachedKs, contexts);
      const fieldEncryptor = createFieldEncryptor(envelope, schema);
      const fallbackHandler = createFallbackHandler(schema);

      const decryptEventSafe = (event) =>
        fieldEncryptor
          .decryptEvent(event)
          .catch(() => fallbackHandler.applyFallbacks(event));

      log.info('Encryption service initialized');

      return {
        wrapEventStore:
          (eventStoreFactory) =>
          (...factoryArgs) =>
            eventStoreFactory(...factoryArgs).then((store) => ({
              addEvent: (correlationId) => (event) => {
                const encLog = getLogger('Encryption/Store', correlationId);

                const shredIfForget = (evt) => {
                  if (evt.type !== 'SUBJECT_FORGOTTEN')
                    return Promise.resolve(evt);
                  const { contexts: ctxs } = evt.payload;
                  const subjectId = evt.payload.subjectId || evt.aggregateId;
                  if (!ctxs || !ctxs.length) return Promise.resolve(evt);
                  return Promise.all(
                    ctxs.map((ctx) => {
                      envelope.clearCachedDEKs(subjectId, ctx);
                      return cachedKs.deleteKeysForSubjectContext(
                        subjectId,
                        ctx,
                      );
                    }),
                  ).then(() => evt);
                };

                return fieldEncryptor
                  .encryptEvent(event)
                  .then((encryptedEvent) => {
                    encLog.debug(
                      `Encrypted event type=${event.type} ` +
                        `aggregate=${event.aggregateName}(${event.aggregateId})`,
                    );
                    return store
                      .addEvent(correlationId)(encryptedEvent)
                      .then(() => shredIfForget(event));
                  })
                  .catch((err) => {
                    if (err.code === 'SUBJECT_FORGOTTEN') {
                      throw Object.assign(
                        new Error(
                          'Cannot modify subject whose personal data has been forgotten',
                        ),
                        {
                          name: 'SubjectForgottenError',
                          code: 'SUBJECT_FORGOTTEN',
                        },
                      );
                    }
                    throw err;
                  });
              },

              getEventsForAggregate: store.getEventsForAggregate
                ? (aggregateName, aggregateId) =>
                    store
                      .getEventsForAggregate(aggregateName, aggregateId)
                      .then((events) =>
                        Promise.all(events.map(decryptEventSafe)),
                      )
                : undefined,

              // Wrap replay to decrypt events before aggregate
              // projection. During command processor startup, replay
              // reads encrypted events from the store and passes them
              // to applyAggregateProjection which needs plaintext.
              // The original replay uses collection.find().forEach()
              // calling applyAggregateProjection(correlationId)(event).
              // We intercept the cmdProcContext to wrap
              // applyAggregateProjection with a decrypt step.
              replay: (correlationId) => (cmdProcContext) => {
                const wrappedContext = {
                  ...cmdProcContext,
                  aggregateStore: {
                    ...cmdProcContext.aggregateStore,
                    applyAggregateProjection: (corrId) => (event) =>
                      decryptEventSafe(event).then((decrypted) =>
                        cmdProcContext.aggregateStore.applyAggregateProjection(
                          corrId,
                        )(decrypted),
                      ),
                  },
                };
                return store.replay(correlationId)(wrappedContext);
              },

              close: store.close,
            })),

        wrapEventBus:
          (eventBusFactory) =>
          (...factoryArgs) =>
            eventBusFactory(...factoryArgs).then((bus) => ({
              ...bus,
              publishEvent: (correlationId) => (event) => {
                const busLog = getLogger('Encryption/Bus', correlationId);
                return fieldEncryptor.hasEncryptedFields(event)
                  ? bus.publishEvent(correlationId)(event)
                  : fieldEncryptor.encryptEvent(event).then((encrypted) => {
                      busLog.debug(
                        `Encrypted event for bus: type=${event.type}`,
                      );
                      return bus.publishEvent(correlationId)(encrypted);
                    });
              },
            })),

        createProjectionDecryptor: (role) => (event) =>
          fieldEncryptor
            .decryptEvent(event, { role, contexts })
            .catch(() => fallbackHandler.applyFallbacks(event)),

        wrapStorage: (storageFactory) =>
          readModelEncryption
            ? createStorageEncryptor(
                storageFactory,
                readModelEncryption,
                envelope,
              )
            : storageFactory,

        createQueryDecryptor: () =>
          readModelEncryption
            ? createQueryDecryptorImpl(
                readModelEncryption,
                envelope,
                schema,
                contexts,
              )
            : null,

        forgetSubjectContext: (subjectId, contextName) => {
          log.info(`Forgetting subject context: ${subjectId}/${contextName}`);
          envelope.clearCachedDEKs(subjectId, contextName);
          return cachedKs.deleteKeysForSubjectContext(subjectId, contextName);
        },

        forgetSubject: (subjectId) => {
          log.info(`Forgetting subject: ${subjectId}`);
          const autoForgetContexts = Object.entries(contexts)
            .filter(([, cfg]) => cfg.autoForget)
            .map(([name]) => name);
          if (!autoForgetContexts.length) {
            return Promise.reject(
              Object.assign(
                new Error(
                  'No contexts with autoForget enabled — ' +
                    'use forgetSubjectContext for explicit context forgetting',
                ),
                { code: 'NO_AUTO_FORGET_CONTEXTS' },
              ),
            );
          }
          return Promise.all(
            autoForgetContexts.map((ctx) => {
              envelope.clearCachedDEKs(subjectId, ctx);
              return cachedKs.deleteKeysForSubjectContext(subjectId, ctx);
            }),
          ).then(() => autoForgetContexts);
        },

        rotateContextKey: (contextName) => {
          log.info(`Rotating KEK for context: ${contextName}`);
          return envelope.rotateKEK(contextName);
        },

        getSchema: () => schema,

        getContexts: () => contexts,

        getSubjects: () => subjects,

        createForgetMixin: () =>
          createForgetMixinImpl(contexts, { authorizeForget }),
      };
    });
};
