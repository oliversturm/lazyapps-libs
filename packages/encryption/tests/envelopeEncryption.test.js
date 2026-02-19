import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const { createEnvelopeManager } = await import('../envelopeEncryption.js');

describe('createEnvelopeManager', () => {
  let mockKeyStore;
  let envelope;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKeyStore = {
      getDEK: vi.fn(),
      wrapDEK: vi.fn(),
      storeDEK: vi.fn(),
      unwrapDEK: vi.fn(),
    };
    envelope = createEnvelopeManager(mockKeyStore, {});
  });

  describe('getDEK', () => {
    test('creates new DEK when none exists', () => {
      const wrappedKey = { iv: 'a', data: 'b', tag: 'c' };
      mockKeyStore.getDEK.mockResolvedValue(null);
      mockKeyStore.wrapDEK.mockResolvedValue(wrappedKey);
      mockKeyStore.storeDEK.mockResolvedValue();

      return envelope.getDEK('subject-1', 'personal').then((result) => {
        expect(result.key).toBeInstanceOf(Buffer);
        expect(result.key.length).toBe(32);
        expect(result.version).toBe(1);
        expect(result.wrappedKey).toBe(wrappedKey);

        expect(mockKeyStore.wrapDEK).toHaveBeenCalledWith(
          'personal',
          expect.any(Buffer),
        );
        expect(mockKeyStore.storeDEK).toHaveBeenCalledWith(
          'subject-1',
          'personal',
          expect.objectContaining({
            key: expect.any(Buffer),
            version: 1,
            wrappedKey,
          }),
        );
      });
    });

    test('unwraps existing DEK', () => {
      const plainDEK = randomBytes(32);
      const wrappedKey = { iv: 'x', data: 'y', tag: 'z' };
      mockKeyStore.getDEK.mockResolvedValue({
        wrappedKey,
        version: 3,
      });
      mockKeyStore.unwrapDEK.mockResolvedValue(plainDEK);

      return envelope.getDEK('subject-1', 'personal').then((result) => {
        expect(result.key).toBe(plainDEK);
        expect(result.version).toBe(3);
        expect(mockKeyStore.unwrapDEK).toHaveBeenCalledWith(
          'personal',
          wrappedKey,
        );
      });
    });

    test('passes version to keyStore.getDEK', () => {
      mockKeyStore.getDEK.mockResolvedValue(null);
      mockKeyStore.wrapDEK.mockResolvedValue({});
      mockKeyStore.storeDEK.mockResolvedValue();

      return envelope.getDEK('subject-1', 'personal', 2).then(() => {
        expect(mockKeyStore.getDEK).toHaveBeenCalledWith(
          'subject-1',
          'personal',
          2,
        );
      });
    });
  });

  describe('getDEK isolation', () => {
    test('same subject, different contexts get different DEKs', () => {
      const wrappedKey = { iv: 'a', data: 'b', tag: 'c' };
      mockKeyStore.getDEK.mockResolvedValue(null);
      mockKeyStore.wrapDEK.mockResolvedValue(wrappedKey);
      mockKeyStore.storeDEK.mockResolvedValue();

      return envelope.getDEK('subject-1', 'personal').then((personalDEK) =>
        envelope.getDEK('subject-1', 'financial').then((financialDEK) => {
          expect(Buffer.compare(personalDEK.key, financialDEK.key)).not.toBe(0);
          expect(mockKeyStore.wrapDEK).toHaveBeenCalledWith(
            'personal',
            expect.any(Buffer),
          );
          expect(mockKeyStore.wrapDEK).toHaveBeenCalledWith(
            'financial',
            expect.any(Buffer),
          );
        }),
      );
    });

    test('same context, different subjects get different DEKs', () => {
      const wrappedKey = { iv: 'a', data: 'b', tag: 'c' };
      mockKeyStore.getDEK.mockResolvedValue(null);
      mockKeyStore.wrapDEK.mockResolvedValue(wrappedKey);
      mockKeyStore.storeDEK.mockResolvedValue();

      return envelope.getDEK('subject-1', 'personal').then((dek1) =>
        envelope.getDEK('subject-2', 'personal').then((dek2) => {
          expect(Buffer.compare(dek1.key, dek2.key)).not.toBe(0);
          expect(mockKeyStore.storeDEK).toHaveBeenCalledWith(
            'subject-1',
            'personal',
            expect.anything(),
          );
          expect(mockKeyStore.storeDEK).toHaveBeenCalledWith(
            'subject-2',
            'personal',
            expect.anything(),
          );
        }),
      );
    });
  });

  describe('rotateKEK', () => {
    test('delegates to keyStore if supported', () => {
      mockKeyStore.rotateKEK = vi.fn().mockResolvedValue();
      envelope = createEnvelopeManager(mockKeyStore, {});

      return envelope.rotateKEK('personal').then(() => {
        expect(mockKeyStore.rotateKEK).toHaveBeenCalledWith('personal');
      });
    });

    test('rejects if keyStore does not support rotation', () =>
      expect(envelope.rotateKEK('personal')).rejects.toThrow(
        'KEK rotation not supported',
      ));
  });
});
