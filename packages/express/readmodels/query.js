import { getLogger, safeStringify } from '@lazyapps/logger';
import { sanitizeMongoOperators } from './sanitize.js';

const decryptResult = (
  queryDecryptor,
  result,
  auth,
  jwtScopeMapper,
  serviceRole,
) => {
  if (!queryDecryptor) return Promise.resolve(result);
  const decryptOpts = jwtScopeMapper
    ? jwtScopeMapper(auth)
    : {
        roles:
          auth && auth.roles ? auth.roles : serviceRole ? [serviceRole] : [],
        identity: auth && auth.sub,
      };
  if (Array.isArray(result)) {
    return result.reduce(
      (promise, doc) =>
        promise.then((acc) =>
          queryDecryptor.decrypt(doc, decryptOpts).then((d) => [...acc, d]),
        ),
      Promise.resolve([]),
    );
  }
  return queryDecryptor.decrypt(result, decryptOpts);
};

export const createApiHandler =
  (context) =>
  (readModelName, readModel, resolverName, resolver) =>
  (req, res) => {
    const log = getLogger('RM/Query', req.body.correlationId);

    // SEC-23: req.body is untrusted — strip MongoDB operator tokens and
    // dotted keys before the resolver forwards it into storage queries.
    const safeBody = sanitizeMongoOperators(req.body);

    log.debug(
      `Query received for ${readModelName}/${resolverName} with args ${safeStringify(
        safeBody,
      )}`,
    );
    return Promise.resolve()
      .then(() =>
        resolver(
          context.storage.perRequest(req.body.correlationId),
          safeBody,
          req.auth,
          req.body.correlationId,
        ),
      )
      .then((result) =>
        decryptResult(
          context.encryptionQueryDecryptor,
          result,
          req.auth,
          context.jwtScopeMapper,
          context.encryptionRole,
        ),
      )
      .then((result) => {
        res.status(200).json(result);
      })
      .catch((err) => {
        log.error(
          `An error occurred handling query for ${readModelName}/${resolverName} with args ${safeStringify(
            safeBody,
          )}: ${err}`,
        );
        if (err.name === 'ValidationError') {
          res.sendStatus(400);
        } else if (err.name === 'AuthorizationError') {
          res.sendStatus(403);
        } else {
          res.sendStatus(500);
        }
      });
  };
