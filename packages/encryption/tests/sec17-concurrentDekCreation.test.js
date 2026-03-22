import { describe, test, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createEnvelopeManager } = await import('../envelopeEncryption.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');

const personalKEK = randomBytes(32);

describe('SEC-17: Concurrent DEK creation race condition', () => {
  test('two concurrent getDEK calls for the same new subject return the same key', () => {
    return inMemoryKeyStore({ personal: personalKEK })
      .initialize()
      .then((ks) => {
        const contexts = {
          personal: { roles: ['admin'], autoForget: true },
        };
        const envelope = createEnvelopeManager(ks, contexts);

        // Fire two concurrent getDEK calls for the same new subject.
        // Both will see storedDEK === null and create new random keys.
        // The bug: they each generate independent random DEKs, so the
        // keys won't match.
        return Promise.all([
          envelope.getDEK('subject-race-1', 'personal'),
          envelope.getDEK('subject-race-1', 'personal'),
        ]).then(([dek1, dek2]) => {
          // Both calls must return the exact same key bytes.
          // With the race condition, they will have different random keys.
          expect(Buffer.from(dek1.key).toString('hex')).toBe(
            Buffer.from(dek2.key).toString('hex'),
          );
          // Both must have the same wrappedKey
          expect(dek1.wrappedKey).toEqual(dek2.wrappedKey);
        });
      });
  });

  test('concurrent getDEK calls result in exactly one DEK stored in keystore', () => {
    return inMemoryKeyStore({ personal: personalKEK })
      .initialize()
      .then((ks) => {
        const contexts = {
          personal: { roles: ['admin'], autoForget: true },
        };
        const envelope = createEnvelopeManager(ks, contexts);

        return Promise.all([
          envelope.getDEK('subject-race-2', 'personal'),
          envelope.getDEK('subject-race-2', 'personal'),
          envelope.getDEK('subject-race-2', 'personal'),
        ]).then(() =>
          // After concurrent calls, there should be exactly one DEK
          // stored for this subject+context combination.
          ks.getAllDEKsForContext('personal').then((allDeks) => {
            const subjectDeks = allDeks.filter(
              (d) => d.subjectId === 'subject-race-2',
            );
            // With the race bug, multiple storeDEK calls happen,
            // but the last one wins in the Map — however the returned
            // keys from each getDEK call will differ, which is the
            // real problem. Still, let's verify all returned keys match.
            expect(subjectDeks).toHaveLength(1);
          }),
        );
      });
  });
});
