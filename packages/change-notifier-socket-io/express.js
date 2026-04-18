import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmetLib from 'helmet';
import { expressjwt } from 'express-jwt';
import { socketIoCookieJwt } from './socketIoCookieJwt.js';
import { Server as SocketIoServer } from 'socket.io';
import http from 'http';
import { nanoid } from 'nanoid';

import { expressJwtSecret } from 'jwks-rsa';
import { getLogger, getStream } from '@lazyapps/logger';
import { initSockets, createNotifier } from './notifier.js';
import { createRedactionEngine } from './redaction.js';

const log = getLogger('Changes/HTTP', 'INIT');

const correlationId = (correlationConfig) => (req, res, next) => {
  // check where a correlation Id might already exist
  const existingId = req.body.correlationId || req.headers['x-correlation-id'];

  // since we want to use it in code, make sure the body
  // now has an id in any case
  req.body.correlationId =
    existingId || `${correlationConfig?.serviceId || 'UNK'}-${nanoid()}`;

  // also in the result, not needed right now but can't hurt
  // for debugging
  res.setHeader('X-Correlation-ID', req.body.correlationId);
  next();
};

morgan.token('correlation-id', function (req) {
  return req.body.correlationId;
});

/**
 * Run the change-notifier HTTP + Socket.io server.
 *
 * @param {object} correlationConfig
 * @param {object} opts
 * @param {number} [opts.port=3008]
 * @param {string} [opts.host='0.0.0.0']
 * @param {string|Function} [opts.jwtAuth]
 * @param {string} [opts.jwtSecret] - Deprecated alias for `jwtAuth`.
 * @param {string[]} [opts.jwtAlgorithms]
 * @param {string} [opts.jwksUri]
 * @param {string} [opts.authCookieName]
 * @param {boolean} [opts.credentialsRequired]
 * @param {Function} [opts.ioAuthHandler]
 * @param {Function} [opts.changeInfoAuthHandler]
 * @param {object} [opts.encryptionSchema]
 * @param {object} [opts.encryptionContexts]
 * @param {Function} [opts.scopeMapper]
 * @param {object} [opts.redactionHooks]
 * @param {string|string[]|Function|boolean} [opts.corsOrigin] - Value passed to
 *   `cors({origin: ...})` and Socket.io `cors`. **DEFAULT IS WILDCARD (`*`)
 *   which is unsafe in production**: any origin can call this server. In
 *   production, set this explicitly, e.g.
 *   `corsOrigin: ['https://app.example.com']`.
 * @param {string|number} [opts.bodyLimit='100kb'] - Max JSON body size for
 *   `/change` POSTs.
 * @param {boolean|object} [opts.helmet] - Enable HTTP security headers via
 *   `helmet`. `true` uses defaults; an object passes through as helmet options.
 * @param {Function} [opts.rateLimiter] - Express-style middleware applied
 *   between `helmet` and `bodyParser`.
 */
const runExpress = (
  correlationConfig,
  {
    port = 3008,
    host = '0.0.0.0',
    jwtAuth,
    jwtSecret, // deprecated alias for jwtAuth
    jwtAlgorithms,
    jwksUri,
    authCookieName,
    credentialsRequired,
    ioAuthHandler,
    changeInfoAuthHandler,
    encryptionSchema,
    encryptionContexts,
    scopeMapper,
    redactionHooks,
    corsOrigin,
    bodyLimit = '100kb',
    helmet,
    rateLimiter,
  },
) => {
  let secret = jwtAuth || jwtSecret;
  return new Promise((resolve, reject) => {
    // Auto-construct secret from jwksUri when not provided directly
    if (jwksUri && !secret) {
      secret = expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri,
      });
      // Default to RS256 for JWKS unless caller explicitly specified algorithms
      if (!jwtAlgorithms) {
        jwtAlgorithms = ['RS256'];
      }
    }
    // Default to HS256 for symmetric secrets when no algorithms specified
    if (!jwtAlgorithms) {
      jwtAlgorithms = ['HS256'];
    }

    const app = express();

    // Middleware order is intentional and security-relevant:
    //   helmet → rateLimiter → bodyParser → cors → routes
    if (helmet) {
      app.use(helmet === true ? helmetLib() : helmetLib(helmet));
    }
    if (rateLimiter) {
      app.use(rateLimiter);
    }
    app.use(bodyParser.json({ limit: bodyLimit }));
    // SECURITY: default `corsOrigin` is wildcard (`*`) — any origin can call
    // this server. UNSAFE in production. Pass `corsOrigin` explicitly to
    // restrict.
    app.use(cors(corsOrigin === undefined ? {} : { origin: corsOrigin }));
    app.use(correlationId(correlationConfig));
    app.use(
      morgan(
        '[:correlation-id] :method :url :status :response-time ms - :res[content-length]',
        { stream: getStream(log.debugBare) },
      ),
    );
    app.use(cookieParser());

    // Similar code as in express/runExpress.js -- refactor?
    if (secret) {
      app.use(
        expressjwt({
          secret,
          algorithms: jwtAlgorithms,
          credentialsRequired: credentialsRequired !== false,
          getToken: (req) => {
            // check Authorization header first
            if (
              req.headers.authorization &&
              req.headers.authorization.split(' ')[0] === 'Bearer'
            ) {
              return req.headers.authorization.split(' ')[1];
            }
            // consider cookie if a name has been given
            if (authCookieName) {
              const token = req.cookies[authCookieName || 'access_token'];
              if (token) {
                return token;
              }
            }
            return null;
          },
        }),
      );
    }

    const server = http.createServer(app);
    const io = new SocketIoServer(server, {
      cors: { origin: corsOrigin === undefined ? true : corsOrigin },
    });
    io.use(
      socketIoCookieJwt({
        jwtAuth: secret,
        jwtAlgorithms,
        jwksUri,
        cookieName: authCookieName,
      }),
    );

    const socketOpts = scopeMapper ? { scopeMapper } : {};
    initSockets(
      correlationConfig,
      io,
      secret && ioAuthHandler ? ioAuthHandler : () => true,
      socketOpts,
    );

    const redactionEngine =
      encryptionSchema && encryptionContexts
        ? createRedactionEngine({
            schema: encryptionSchema,
            contexts: encryptionContexts,
            redactionHooks,
          })
        : undefined;

    const notifier = createNotifier(
      io,
      secret && changeInfoAuthHandler ? changeInfoAuthHandler : () => true,
      redactionEngine ? { redactionEngine } : {},
    );
    app.post('/change', notifier);

    server.listen(port, host);
    server.on('listening', () => {
      resolve(server);
    });
    server.on('error', reject);
  })
    .catch((err) => {
      log.error(`Can't run HTTP server: ${err}`);
    })
    .then((server) => {
      log.info(
        `HTTP API listening on port ${port}, ${
          secret && credentialsRequired ? 'requiring ' : 'checking for '
        } a JWT Bearer token${
          authCookieName ? ` or a cookie named ${authCookieName}` : ''
        }`,
      );
      return server;
    });
};

export { runExpress };
