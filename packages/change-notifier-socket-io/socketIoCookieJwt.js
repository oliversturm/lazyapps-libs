import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { JwksClient } from 'jwks-rsa';

const decodeTokenSync = (jwtAuth, token, algorithms) => {
  try {
    return jwt.verify(token, jwtAuth, { algorithms });
  } catch (err) {
    return null;
  }
};

const decodeTokenJwks = (jwksClient, token, algorithms) => {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    return Promise.resolve(null);
  }
  return jwksClient
    .getSigningKey(decoded.header.kid)
    .then((key) => jwt.verify(token, key.getPublicKey(), { algorithms }))
    .catch(() => null);
};

// Note that this middleware is written to extract the token
// if it can be found, but to simply proceed if it can't.

// Also note: the headers are always the ones from the first
// connection (https://github.com/socketio/socket.io/issues/2860#issuecomment-781411803) --
// so if I needed to refresh the token on the client, it would
// be necessary to reconnect to the server.
export const socketIoCookieJwt = ({
  cookieName = 'access_token',
  jwtAuth,
  jwtSecret, // deprecated alias for jwtAuth
  jwtAlgorithms = ['HS256'],
  jwksUri,
}) => {
  const secret = jwtAuth || jwtSecret;
  const jwksClient = jwksUri
    ? new JwksClient({ jwksUri, cache: true, rateLimit: true })
    : null;

  return (socket, next) => {
    let token = socket.handshake.auth?.token;
    if (!token) {
      const cookieHeader = socket.handshake.headers.cookie;
      if (cookieHeader) {
        const cookies = cookie.parse(cookieHeader);
        token = cookies[cookieName];
      }
    }

    if (!token) {
      next();
      return;
    }

    if (jwksClient) {
      decodeTokenJwks(jwksClient, token, jwtAlgorithms)
        .then((decoded) => {
          socket.decoded_token = decoded;
        })
        .catch(() => {
          socket.decoded_token = null;
        })
        .then(() => next());
    } else {
      socket.decoded_token = decodeTokenSync(secret, token, jwtAlgorithms);
      next();
    }
  };
};
