import { getLogger, safeStringify } from '@lazyapps/logger';
import { nanoid } from 'nanoid';
import { getScopedRoomName } from './redaction.js';

const getBaseRoomName = (endpointName, readModelName, resolverName) =>
  `${endpointName}/${readModelName}/${resolverName}`;

const ioInitLog = getLogger('Changes/IO', 'INIT');

export const initSockets = (
  correlationConfig,
  io,
  ioAuthHandler,
  { scopeMapper } = {},
) => {
  ioInitLog.debug('Initializing sockets');
  io.on('connect', (socket) => {
    const existingId = socket.handshake.query?.correlationId;
    socket.correlationId =
      existingId || `${correlationConfig?.serviceId || 'UNK'}-${nanoid()}`;

    const ioLog = getLogger('Changes/IO', socket.correlationId);

    // Extract and store scopes from JWT at connection time (only with scopeMapper)
    const scopes = scopeMapper ? scopeMapper(socket.decoded_token) : [];
    socket.encryptionScopes = scopes;

    ioLog.debug(
      `Connection: ${socket.id} (handshake: ${safeStringify(
        socket.handshake,
      )})${
        socket.decoded_token
          ? ` (JWT: ${safeStringify(socket.decoded_token)})`
          : ' (no JWT)'
      } (scopes: ${JSON.stringify(scopes)})`,
    );

    socket.on('disconnect', (reason) => {
      ioLog.debug(`Disconnected ${socket.id}, reason: ${reason}`);
    });

    socket.on('error', (error) => {
      ioLog.debug(`Communication error with ${socket.id}: ${error}`);
    });

    socket.on('register', (resolvers, ack) => {
      try {
        if (!ioAuthHandler(socket.decoded_token, resolvers)) {
          ioLog.error(
            `Unauthorized register ${safeStringify(resolvers)} (claims ${
              socket.decoded_token
            })`,
          );
          if (typeof ack === 'function') ack({ error: 'unauthorized' });
          socket.disconnect();
          return;
        }
        const roomNames = resolvers.map(
          ({ endpointName, readModelName, resolverName }) => {
            const baseRoom = getBaseRoomName(
              endpointName,
              readModelName,
              resolverName,
            );
            return scopeMapper ? getScopedRoomName(baseRoom, scopes) : baseRoom;
          },
        );
        socket.join(roomNames);
        ioLog.debug(
          `Registered ${socket.id} for ${safeStringify(resolvers)} (rooms: ${safeStringify(roomNames)})`,
        );
        if (typeof ack === 'function') ack();
      } catch (err) {
        ioLog.error(
          `Can't register ${socket.id} for ${safeStringify(resolvers)}: ${err}`,
        );
        if (typeof ack === 'function') ack({ error: 'Registration failed' });
      }
    });
  });
};

export const createNotifier = (
  io,
  changeInfoAuthHandler,
  { redactionEngine } = {},
) => {
  const handler = (req, res) => {
    const auth = req.auth;
    const rmLog = getLogger('Changes/RM', req.body.correlationId);

    if (!changeInfoAuthHandler(auth)) {
      rmLog.error(
        `Unauthorized changeInfo ${safeStringify(req.body)} (claims ${auth})`,
      );
      res.sendStatus(403);
      return;
    }

    const changeInfo = req.body;
    try {
      const { endpointName, readModelName, resolverName } = changeInfo;
      const baseRoom = getBaseRoomName(
        endpointName,
        readModelName,
        resolverName,
      );

      if (redactionEngine) {
        // Collect all scoped sub-rooms for this base room
        const rooms = io.sockets.adapter.rooms;
        const prefix = `${baseRoom}:scopes=`;
        const scopeGroups = new Map();

        for (const roomName of rooms.keys()) {
          if (roomName.startsWith(prefix)) {
            const scopeStr = roomName.slice(prefix.length);
            scopeGroups.set(
              roomName,
              scopeStr === 'none' ? [] : scopeStr.split(','),
            );
          }
        }

        if (scopeGroups.size > 0) {
          for (const [roomName, scopes] of scopeGroups) {
            const redactedPayload = redactionEngine.redact(changeInfo, scopes);
            io.to(roomName).emit('change', redactedPayload);
          }
        }

        rmLog.debug(
          `Forwarded changeInfo to ${scopeGroups.size} scope group(s) for ${baseRoom}`,
        );
      } else {
        // No redaction engine — broadcast to the base room (backwards-compatible)
        io.to(baseRoom).emit('change', changeInfo);
        rmLog.debug(`Forwarded changeInfo ${safeStringify(changeInfo)}`);
      }

      res.sendStatus(200);
    } catch (err) {
      rmLog.error(
        `Can't forward changeInfo ${safeStringify(changeInfo)}: ${err}`,
      );
      res.sendStatus(500);
    }
  };

  return handler;
};
