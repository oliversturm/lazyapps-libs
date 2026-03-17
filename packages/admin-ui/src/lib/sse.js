const parseSseChunk = (chunk) => {
  let eventType = null;
  let eventData = null;
  chunk.split('\n').forEach((line) => {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line.startsWith('data: ')) eventData = line.slice(6);
  });
  if (eventType && eventData) {
    try {
      return { type: eventType, data: JSON.parse(eventData) };
    } catch {
      return null;
    }
  }
  return null;
};

const createSseConnection = (url, options = {}) => {
  const listeners = {};
  let closed = false;
  let controller = null;
  let retryDelay = 1000;
  const maxRetryDelay = 30000;
  const token = options.token || null;

  const emit = (type, data) => {
    (listeners[type] || []).forEach((fn) => fn(data));
  };

  const connect = () => {
    if (closed) return;

    controller = new AbortController();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch(url, { signal: controller.signal, headers })
      .then((response) => {
        if (!response.ok) {
          emit('error', { status: response.status });
          scheduleReconnect();
          return;
        }

        retryDelay = 1000;
        emit('connected', {});

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = () => {
          reader.read().then(({ done, value }) => {
            if (done || closed) {
              if (!closed) scheduleReconnect();
              return;
            }
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split('\n\n');
            buffer = parts.pop();

            parts.forEach((part) => {
              const parsed = parseSseChunk(part);
              if (parsed) emit(parsed.type, parsed.data);
            });

            read();
          });
        };
        read();
      })
      .catch((err) => {
        if (closed) return;
        emit('error', { message: err.message });
        scheduleReconnect();
      });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    emit('disconnected', {});
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
  };

  const on = (type, fn) => {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
    return connection;
  };

  const close = () => {
    closed = true;
    if (controller) controller.abort();
  };

  const connection = { on, close };

  connect();

  return connection;
};

export { createSseConnection };
