import expressApp from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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
    customizeExpress = () => {},
  }) =>
  (context) => {
    const secret = jwtAuth || jwtSecret;
    return new Promise((resolve, reject) => {
      const app = expressApp();
      app.use(cors());
      app.use(bodyParser.json());
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
