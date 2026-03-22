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

describe('SEC-18: Forget+encrypt race resurrects deleted keys', () => {
  // The core bug: envelopeEncryption.js:29-42 checks storedDEK first.
  // If storedDEK is null AND wrappedKey is provided, it unwraps and
  // re-stores the DEK — resurrecting a deleted key. This defeats
  // crypto-shredding because:
  //
  // 1. Subject is forgotten (DEK deleted from keystore)
  // 2. A stored event still has the wrappedKey in its encrypted field metadata
  // 3. When that event is processed (e.g. during replay or re-encryption),
  //    getDEK is called with the wrappedKey
  // 4. The code sees storedDEK===null, but since wrappedKey is provided,
  //    it unwraps and re-stores — the DEK is back in the keystore
  //
  // The test uses a keystore wrapper that simulates the race: getDEK
  // returns null (as if the deletion just happened and the forgotten
  // tombstone hasn't been written yet or the keystore doesn't track it).

  test('getDEK with wrappedKey must not re-store a key when the subject has been forgotten', () => {
    return inMemoryKeyStore({ personal: personalKEK })
      .initialize()
      .then((ks) => {
        const contexts = {
          personal: { roles: ['admin'], autoForget: true },
        };
        const envelope = createEnvelopeManager(ks, contexts);

        // Step 1: Create a DEK for the subject
        return envelope
          .getDEK('subject-forget-1', 'personal')
          .then((dekInfo) => {
            const savedWrappedKey = dekInfo.wrappedKey;
            const savedVersion = dekInfo.version;

            // Step 2: Forget — delete DEK and clear cache
            envelope.clearCachedDEKs('subject-forget-1', 'personal');
            return ks
              .deleteKeysForSubjectContext('subject-forget-1', 'personal')
              .then(() => {
                // Step 3: Simulate the race window. Wrap the keystore's
                // getDEK to return null instead of { forgotten: true }
                // for this subject — as would happen if the forgotten
                // tombstone hasn't been written yet, or if the keystore
                // implementation doesn't track forgotten state.
                const originalGetDEK = ks.getDEK;
                ks.getDEK = (subjectId, contextName, version) => {
                  if (
                    subjectId === 'subject-forget-1' &&
                    contextName === 'personal'
                  ) {
                    return Promise.resolve(null);
                  }
                  return originalGetDEK(subjectId, contextName, version);
                };

                return { savedWrappedKey, savedVersion };
              });
          })
          .then(({ savedWrappedKey, savedVersion }) =>
            // Step 4: Call getDEK with the saved wrappedKey.
            // BUG: The code sees null (no DEK) + wrappedKey provided,
            // so it unwraps and re-stores, resurrecting the key.
            // EXPECTED: Should reject because the subject was forgotten.
            envelope
              .getDEK(
                'subject-forget-1',
                'personal',
                savedVersion,
                savedWrappedKey,
              )
              .then((resurrected) => {
                // If we reach here, the DEK was resurrected — the bug exists.
                // The key should NOT have been re-stored.
                // We verify by checking that storeDEK was called (the key
                // is now back in the keystore), which defeats crypto-shredding.
                throw new Error(
                  'Expected SUBJECT_FORGOTTEN rejection but getDEK succeeded — ' +
                    'key was resurrected from wrappedKey, defeating crypto-shredding',
                );
              })
              .catch((err) => {
                if (
                  err.message &&
                  err.message.includes('key was resurrected')
                ) {
                  throw err;
                }
                expect(err.code).toBe('SUBJECT_FORGOTTEN');
              }),
          );
      });
  });

  test('after forget, re-storing via wrappedKey makes the key available again (demonstrating the vulnerability)', () => {
    return inMemoryKeyStore({ personal: personalKEK })
      .initialize()
      .then((ks) => {
        const contexts = {
          personal: { roles: ['admin'], autoForget: true },
        };
        const envelope = createEnvelopeManager(ks, contexts);

        // Step 1: Create a DEK
        return envelope
          .getDEK('subject-vuln-1', 'personal')
          .then((dekInfo) => {
            const savedWrappedKey = dekInfo.wrappedKey;
            const savedVersion = dekInfo.version;
            const originalKeyHex = Buffer.from(dekInfo.key).toString('hex');

            // Step 2: Forget the subject
            envelope.clearCachedDEKs('subject-vuln-1', 'personal');
            return ks
              .deleteKeysForSubjectContext('subject-vuln-1', 'personal')
              .then(() => {
                // Patch to simulate race (getDEK returns null not forgotten)
                const originalGetDEK = ks.getDEK;
                ks.getDEK = (subjectId, contextName, version) => {
                  if (
                    subjectId === 'subject-vuln-1' &&
                    contextName === 'personal'
                  ) {
                    return Promise.resolve(null);
                  }
                  return originalGetDEK(subjectId, contextName, version);
                };

                return { savedWrappedKey, savedVersion, originalKeyHex };
              });
          })
          .then(({ savedWrappedKey, savedVersion, originalKeyHex }) =>
            // Step 3: getDEK with wrappedKey — this should NOT succeed
            // but due to the bug it will resurrect the key
            envelope
              .getDEK(
                'subject-vuln-1',
                'personal',
                savedVersion,
                savedWrappedKey,
              )
              .then((resurrected) => {
                // The key was resurrected from the wrappedKey.
                // Verify it's the same key material — proving crypto-shredding
                // was completely defeated.
                const resurrectedHex = Buffer.from(resurrected.key).toString(
                  'hex',
                );
                expect(resurrectedHex).toBe(originalKeyHex);
                // This test PASSES when the bug exists (proving the vuln).
                // After the fix, getDEK should reject and we should never
                // reach this point. So we fail explicitly:
                expect.unreachable(
                  'Crypto-shredding defeated: forgotten key was resurrected from wrappedKey',
                );
              })
              .catch((err) => {
                // After the fix, this catch should get SUBJECT_FORGOTTEN
                if (err.message && err.message.includes('Crypto-shredding')) {
                  throw err;
                }
                expect(err.code).toBe('SUBJECT_FORGOTTEN');
              }),
          );
      });
  });
});
