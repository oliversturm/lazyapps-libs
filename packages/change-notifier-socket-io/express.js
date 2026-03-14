import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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

const runExpress = (
  correlationConfig,
  {
    port = 3008,
    host = '0.0.0.0',
    jwtSecret,
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
  },
) => {
  return new Promise((resolve, reject) => {
    // Auto-construct jwtSecret from jwksUri when jwtSecret is not provided
    if (jwksUri && !jwtSecret) {
      jwtSecret = expressJwtSecret({
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
    app.use(cors());
    app.use(bodyParser.json());
    app.use(correlationId(correlationConfig));
    app.use(
      morgan(
        '[:correlation-id] :method :url :status :response-time ms - :res[content-length]',
        { stream: getStream(log.debugBare) },
      ),
    );
    app.use(cookieParser());

    // Similar code as in express/runExpress.js -- refactor?
    if (jwtSecret) {
      app.use(
        expressjwt({
          secret: jwtSecret,
          algorithms: jwtAlgorithms,
          credentialsRequired: credentialsRequired || false,
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
      cors: { origin: true },
    });
    io.use(
      socketIoCookieJwt({
        jwtSecret,
        jwtAlgorithms,
        jwksUri,
        cookieName: authCookieName,
      }),
    );

    const socketOpts = scopeMapper ? { scopeMapper } : {};
    initSockets(
      correlationConfig,
      io,
      jwtSecret && ioAuthHandler ? ioAuthHandler : () => true,
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
      jwtSecret && changeInfoAuthHandler ? changeInfoAuthHandler : () => true,
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
          jwtSecret && credentialsRequired ? 'requiring ' : 'checking for '
        } a JWT Bearer token${
          authCookieName ? ` or a cookie named ${authCookieName}` : ''
        }`,
      );
      return server;
    });
};

export { runExpress };
