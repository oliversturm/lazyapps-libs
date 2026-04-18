import expressApp from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmetLib from 'helmet';
import { expressjwt } from 'express-jwt';
import { getLogger, getStream } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

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
 * Run an Express HTTP server for a LazyApps command receiver / read model
 * query endpoint.
 *
 * @param {object} opts
 * @param {object} opts.log - Logger.
 * @param {number} opts.port - Listen port.
 * @param {string} [opts.interfaceIp] - Interface to bind (default '0.0.0.0').
 * @param {Function} opts.installHandlers - `(context, app) => void` to mount routes.
 * @param {string|Function} [opts.jwtAuth] - JWT secret or jwks-rsa secret provider.
 * @param {string} [opts.jwtSecret] - Deprecated alias for `jwtAuth`.
 * @param {string[]} [opts.jwtAlgorithms=['HS256']] - JWT algorithms allowed.
 * @param {string} [opts.authCookieName] - Cookie name to read JWTs from.
 * @param {boolean} [opts.credentialsRequired] - When false, JWTs are optional.
 * @param {string|string[]|Function|boolean} [opts.corsOrigin] - Value passed to
 *   `cors({origin: ...})`. **DEFAULT IS WILDCARD (`*`) which is unsafe in
 *   production**: any origin can call this server. In production, set this
 *   explicitly, e.g. `corsOrigin: ['https://app.example.com']`. See README
 *   for details.
 * @param {string|number} [opts.bodyLimit='100kb'] - Max JSON body size passed
 *   to `bodyParser.json({limit})`. Strings like `'1mb'` or numbers in bytes.
 *   Per-request — applies to a single body, not aggregate traffic.
 * @param {boolean|object} [opts.helmet] - Enable HTTP security headers via
 *   `helmet`. `true` uses defaults; an object is passed through as helmet
 *   options (e.g. `{contentSecurityPolicy: false}`). Falsy/undefined disables.
 * @param {Function} [opts.rateLimiter] - Express-style middleware
 *   `(req, res, next) => ...` applied early in the chain (after `helmet`,
 *   before `bodyParser`). For multiple/conditional limiters or other
 *   non-standard middleware, use `customizeExpress` instead.
 * @param {Function} [opts.customizeExpress] - `(context, app) => void` escape
 *   hatch invoked AFTER `installHandlers`. Use for arbitrary Express
 *   customisation that does not fit the dedicated parameters.
 */
export const runExpress =
  ({
    log,
    port,
    interfaceIp,
    installHandlers,
    jwtAuth,
    jwtSecret, // deprecated alias for jwtAuth
    jwtAlgorithms = ['HS256'],
    authCookieName,
    credentialsRequired,
    corsOrigin,
    bodyLimit = '100kb',
    helmet,
    rateLimiter,
    customizeExpress = () => {},
  }) =>
  (context) => {
    const secret = jwtAuth || jwtSecret;
    return new Promise((resolve, reject) => {
      const app = expressApp();

      // Middleware order is intentional and security-relevant:
      //   helmet → rateLimiter → bodyParser → cors → routes
      // helmet first so all responses (including errors) carry security
      // headers. rateLimiter before bodyParser so DoS-style oversize bodies
      // are dropped before being parsed. cors last among the cross-cutting
      // middleware so it sees the already-parsed body if a route inspects it.
      if (helmet) {
        app.use(helmet === true ? helmetLib() : helmetLib(helmet));
      }
      if (rateLimiter) {
        app.use(rateLimiter);
      }
      app.use(bodyParser.json({ limit: bodyLimit }));
      // SECURITY: default `corsOrigin` is wildcard (`*`) — any origin can
      // call this server. UNSAFE in production. Pass `corsOrigin` explicitly
      // (e.g. `['https://app.example.com']`) to lock it down. See README.
      app.use(cors(corsOrigin === undefined ? {} : { origin: corsOrigin }));
      app.use(correlationId(context.correlationConfig));
      app.use(
        morgan(
          '[:correlation-id] :method :url :status :response-time ms - :res[content-length]',
          { stream: getStream(log.debugBare) },
        ),
      );
      app.use(cookieParser());

      if (secret) {
        app.use(
          expressjwt({
            secret,
            algorithms: jwtAlgorithms,
            credentialsRequired: credentialsRequired !== false,
            getToken: (req) => {
              const tokenLog = getLogger('Tokens/GetT', req.body.correlationId);
              if (
                req.headers.authorization &&
                req.headers.authorization.split(' ')[0] === 'Bearer'
              ) {
                tokenLog.debug('Using Authorization header');
                return req.headers.authorization.split(' ')[1];
              }
              if (authCookieName) {
                const token = req.cookies[authCookieName || 'access_token'];
                if (token) {
                  tokenLog.debug('Using cookie');
                  return token;
                }
              }
              tokenLog.debug('No token found');
              return null;
            },
          }),
        );
      }

      installHandlers(context, app);

      customizeExpress(context, app);

      // Handle JWT authentication errors
      app.use((err, req, res, next) => {
        if (err.name === 'UnauthorizedError') {
          res.clearCookie(authCookieName || 'access_token', {
            httpOnly: true,
            sameSite: 'strict',
          });
          res.status(401).json({
            error: 'Token expired or invalid',
            code: 'token_expired',
          });
        } else {
          next(err);
        }
      });

      const server = app.listen(port, interfaceIp || '0.0.0.0');

      server.on('error', (err) => {
        log.error(`Server error: ${err}`);
        reject(err);
      });

      server.on('listening', () => {
        const addr = server.address();
        log.info(
          `Server listening on ${addr.address}:${addr.port}, ${
            secret ? 'with JWT' : 'without JWT'
          }`,
        );
        resolve(server);
      });
    });
  };
