import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

// Capture logger calls per logger name so tests can assert on them.
const loggerCalls = new Map();
const getLoggerImpl = (name) => {
  const bucket = loggerCalls.get(name) || {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  loggerCalls.set(name, bucket);
  return {
    debug: (msg) => bucket.debug.push(msg),
    info: (msg) => bucket.info.push(msg),
    warn: (msg) => bucket.warn.push(msg),
    error: (msg) => bucket.error.push(msg),
  };
};

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn((name) => getLoggerImpl(name)),
  safeStringify: (obj) => JSON.stringify(obj),
}));

// OpenTelemetry metric spy. Every meter returned by getMeter shares a single
// global counter registry keyed by (meterName, counterName) so that whichever
// meter the production code uses, we can observe the adds.
const counterAdds = [];
const createdCounters = new Map();
vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: (meterName) => ({
      createCounter: (name, opts) => {
        const key = `${meterName}::${name}`;
        if (createdCounters.has(key)) return createdCounters.get(key);
        const counter = {
          add: (value, attrs) =>
            counterAdds.push({
              meter: meterName,
              name,
              value,
              attrs: { ...(attrs || {}) },
            }),
          __meta: { meterName, name, opts },
        };
        createdCounters.set(key, counter);
        return counter;
      },
      createHistogram: () => ({ record: vi.fn() }),
    }),
  },
}));

const { createEncryption } = await import('../encryption.js');
const { defineEncryptionSchema } = await import('../schema.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');

const personalKEK = randomBytes(32);

const schema = defineEncryptionSchema({
  events: {
    CUSTOMER_CREATED: {
      'payload.name': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
    },
  },
});

const contexts = {
  personal: { roles: ['admin', 'support'], autoForget: true },
};

const makeEncryption = () =>
  createEncryption({
    schema,
    keyStore: inMemoryKeyStore({ personal: personalKEK }),
    contexts,
    cache: { maxSize: 100, ttlMs: 60000 },
  });

// Store an encrypted event and return both the raw ciphertext envelope and
// the stored event (encrypted). Uses wrapEventStore which is the same flow
// as production.
const encryptAndStoreEvent = (enc, aggregateId = 'cust-1') => {
  const storedEvents = [];
  const mockStore = {
    addEvent: () => (event) => {
      storedEvents.push(event);
      return Promise.resolve(event);
    },
    replay: vi.fn(),
    close: vi.fn(),
  };
  const wrappedFactory = enc.wrapEventStore(() => Promise.resolve(mockStore));
  return wrappedFactory().then((wrapped) =>
    wrapped
      .addEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId,
        payload: { name: 'Alice' },
        timestamp: 1,
      })
      .then(() => ({ wrapped, storedEvents })),
  );
};

describe('SEC-16: decryption failure distinction (forgotten vs tampered)', () => {
  beforeEach(() => {
    loggerCalls.clear();
    counterAdds.length = 0;
    createdCounters.clear();
  });

  test('(a) forget-and-replay still produces forgotten fallback (regression)', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(storedEvents[0])
          .then((decrypted) => {
            expect(decrypted.payload.name).toBe('Alice');
            return enc.forgetSubjectContext('cust-1', 'personal');
          })
          .then(() => decryptor(storedEvents[0]))
          .then((afterForget) => {
            expect(afterForget.payload.name).toEqual({
              forgotten: true,
              text: '[deleted]',
            });
            // Must NOT have the tampered-data marker
            expect(afterForget.payload.name.decryptionFailed).toBeUndefined();
          });
      }),
    ));

  test('(b) tampered ciphertext for a NON-forgotten subject produces the decryptionFailed marker', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        // Tamper the auth tag — subject is NOT forgotten.
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        // Flip one byte of the tag to force auth failure on decrypt.
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(tampered).then((result) => {
          // Distinct marker shape — NOT the forgotten marker.
          expect(result.payload.name).toEqual({
            decryptionFailed: true,
            text: '[ENCRYPTED — DECRYPTION FAILED]',
          });
          expect(result.payload.name.forgotten).toBeUndefined();
        });
      }),
    ));

  test('(b2) ERROR log emitted on tampered ciphertext for non-forgotten subject', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(tampered).then(() => {
          // Some encryption-related logger must have emitted an ERROR entry
          // that mentions the subject and field.
          const allErrors = Array.from(loggerCalls.entries())
            .filter(([name]) => name.startsWith('Encryption'))
            .flatMap(([, bucket]) => bucket.error);
          expect(allErrors.length).toBeGreaterThan(0);
          const joined = allErrors.join('\n');
          expect(joined).toMatch(/cust-1/);
          expect(joined).toMatch(/personal/);
          expect(joined).toMatch(/payload\.name/);
        });
      }),
    ));

  test('(b3) ERROR log must NOT contain plaintext or full ciphertext payload bytes', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        const cipherData = tampered.payload.name.data;
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(tampered).then(() => {
          const allLogs = Array.from(loggerCalls.values()).flatMap((b) => [
            ...b.debug,
            ...b.info,
            ...b.warn,
            ...b.error,
          ]);
          const joined = allLogs.join('\n');
          // Plaintext must never leak into logs.
          expect(joined).not.toContain('Alice');
          // Full base64 ciphertext payload must not be logged either.
          expect(joined).not.toContain(cipherData);
        });
      }),
    ));

  test('(c) tampered ciphertext increments `failed` counter', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(tampered).then(() => {
          const failedAdds = counterAdds.filter(
            (c) =>
              c.name === 'lazyapps.encryption.decryption.events' &&
              c.attrs.result === 'failed',
          );
          expect(failedAdds.length).toBeGreaterThan(0);
          expect(failedAdds[0].value).toBe(1);
          expect(failedAdds[0].attrs.context).toBe('personal');
        });
      }),
    ));

  test('(d) forgotten subject increments `forgotten` counter', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const decryptor = enc.createProjectionDecryptor('admin');
        return enc
          .forgetSubjectContext('cust-1', 'personal')
          .then(() => decryptor(storedEvents[0]))
          .then(() => {
            const forgottenAdds = counterAdds.filter(
              (c) =>
                c.name === 'lazyapps.encryption.decryption.events' &&
                c.attrs.result === 'forgotten',
            );
            expect(forgottenAdds.length).toBeGreaterThan(0);
            expect(forgottenAdds[0].value).toBe(1);
            expect(forgottenAdds[0].attrs.context).toBe('personal');
          });
      }),
    ));

  test('(e) successful decrypt increments `success` counter', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(storedEvents[0]).then((decrypted) => {
          expect(decrypted.payload.name).toBe('Alice');
          const successAdds = counterAdds.filter(
            (c) =>
              c.name === 'lazyapps.encryption.decryption.events' &&
              c.attrs.result === 'success',
          );
          expect(successAdds.length).toBeGreaterThan(0);
          expect(successAdds[0].value).toBe(1);
          expect(successAdds[0].attrs.context).toBe('personal');
        });
      }),
    ));

  test('(f) forgotten-branch log does NOT contain plaintext or ciphertext payload', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const cipherData = storedEvents[0].payload.name.data;
        const decryptor = enc.createProjectionDecryptor('admin');
        return enc
          .forgetSubjectContext('cust-1', 'personal')
          .then(() => decryptor(storedEvents[0]))
          .then(() => {
            const allLogs = Array.from(loggerCalls.values()).flatMap((b) => [
              ...b.debug,
              ...b.info,
              ...b.warn,
              ...b.error,
            ]);
            const joined = allLogs.join('\n');
            expect(joined).not.toContain('Alice');
            expect(joined).not.toContain(cipherData);
            // But subject ID and field path are acceptable context (and in
            // fact useful for operators) — forgotten branch should mention
            // the subject so operators can correlate.
            // (We don't require it here; regression tests elsewhere confirm
            // shape — we only assert no leakage.)
          });
      }),
    ));

  test('(g) tampered marker is a DISTINCT shape, not confused with forgotten', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const decryptor = enc.createProjectionDecryptor('admin');
        return decryptor(tampered).then((result) => {
          const marker = result.payload.name;
          // Exactly these two keys — nothing else.
          expect(Object.keys(marker).sort()).toEqual([
            'decryptionFailed',
            'text',
          ]);
          expect(marker.decryptionFailed).toBe(true);
          expect(marker.text).toBe('[ENCRYPTED — DECRYPTION FAILED]');
          // And the forgotten-marker shape must not appear.
          expect(marker.forgotten).toBeUndefined();
        });
      }),
    ));

  test('(h) decryptEventSafe (wrapEventStore.getEventsForAggregate) uses same distinction', () =>
    makeEncryption().then((enc) =>
      encryptAndStoreEvent(enc).then(({ storedEvents }) => {
        const tampered = JSON.parse(JSON.stringify(storedEvents[0]));
        const tagBuf = Buffer.from(tampered.payload.name.tag, 'base64');
        tagBuf[0] = tagBuf[0] ^ 0xff;
        tampered.payload.name.tag = tagBuf.toString('base64');

        const backing = {
          addEvent: () => () => Promise.resolve(),
          getEventsForAggregate: () => Promise.resolve([tampered]),
          replay: vi.fn(),
          close: vi.fn(),
        };
        return enc
          .wrapEventStore(() => Promise.resolve(backing))()
          .then((wrapped) =>
            wrapped.getEventsForAggregate('customer', 'cust-1'),
          )
          .then((events) => {
            expect(events[0].payload.name).toEqual({
              decryptionFailed: true,
              text: '[ENCRYPTED — DECRYPTION FAILED]',
            });
          });
      }),
    ));
});
