import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const { createStorageEncryptor } = await import('../storageEncryption.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');
const { createEnvelopeManager } = await import('../envelopeEncryption.js');

const testKEK = randomBytes(32);

const readModelEncryption = {
  customers: {
    name: { context: 'personal', subjectField: 'customerId' },
    location: { context: 'personal', subjectField: 'customerId' },
  },
  orderSummaries: {
    customerName: {
      context: 'personal',
      subjectField: 'customerId',
    },
  },
};

describe('createStorageEncryptor', () => {
  let envelope;
  let mockMethods;
  let mockStorageFactory;
  let wrappedFactory;

  beforeEach(() =>
    inMemoryKeyStore({ personal: testKEK })
      .initialize()
      .then((ks) => {
        envelope = createEnvelopeManager(ks, {
          personal: { roles: ['admin'] },
        });

        mockMethods = {
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          insertMany: vi.fn().mockResolvedValue({ acknowledged: true }),
          updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
          updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
          findOneAndUpdate: vi.fn().mockResolvedValue(null),
          findOneAndReplace: vi.fn().mockResolvedValue(null),
          findOneAndDelete: vi.fn().mockResolvedValue(null),
          bulkWrite: vi.fn().mockResolvedValue({ acknowledged: true }),
          find: vi.fn().mockReturnValue({ toArray: () => [] }),
          deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
          countDocuments: vi.fn().mockResolvedValue(0),
        };

        mockStorageFactory = vi.fn().mockResolvedValue({
          perRequest: () => mockMethods,
          close: vi.fn(),
          updateLastProjectedEventTimestamps: vi.fn(),
          readLastProjectedEventTimestamps: vi.fn(),
        });

        wrappedFactory = createStorageEncryptor(
          mockStorageFactory,
          readModelEncryption,
          envelope,
        );
      }),
  );

  describe('factory wrapping', () => {
    test('wraps storage factory and preserves non-perRequest methods', () =>
      wrappedFactory().then((storage) => {
        expect(storage.close).toBeDefined();
        expect(storage.updateLastProjectedEventTimestamps).toBeDefined();
        expect(storage.readLastProjectedEventTimestamps).toBeDefined();
        expect(storage.perRequest).toBeTypeOf('function');
      }));

    test('passes factory args through', () =>
      wrappedFactory('arg1', 'arg2').then(() => {
        expect(mockStorageFactory).toHaveBeenCalledWith('arg1', 'arg2');
      }));
  });

  describe('insertOne', () => {
    test('encrypts PII fields and leaves non-PII plaintext', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .insertOne('customers', {
            customerId: 'cust-1',
            name: 'Alice',
            location: 'Berlin',
            accountType: 'premium',
          })
          .then(() => {
            const doc = mockMethods.insertOne.mock.calls[0][1];
            expect(doc.name.__encrypted).toBe(true);
            expect(doc.name.alg).toBe('aes-256-gcm');
            expect(doc.name.ctx).toBe('personal');
            expect(doc.name.kid).toBe('cust-1');
            expect(doc.name.kv).toBe(1);
            expect(doc.location.__encrypted).toBe(true);
            expect(doc.location.ctx).toBe('personal');
            expect(doc.customerId).toBe('cust-1');
            expect(doc.accountType).toBe('premium');
          });
      }));

    test('skips null/undefined field values', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .insertOne('customers', {
            customerId: 'cust-1',
            name: null,
            location: undefined,
          })
          .then(() => {
            const doc = mockMethods.insertOne.mock.calls[0][1];
            expect(doc.name).toBeNull();
            expect(doc.location).toBeUndefined();
          });
      }));

    test('skips if subjectField is missing', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .insertOne('customers', {
            name: 'Alice',
            location: 'Berlin',
          })
          .then(() => {
            const doc = mockMethods.insertOne.mock.calls[0][1];
            expect(doc.name).toBe('Alice');
            expect(doc.location).toBe('Berlin');
          });
      }));
  });

  describe('updateOne', () => {
    test('encrypts PII fields in $set', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateOne(
            'customers',
            { customerId: 'cust-1' },
            {
              $set: {
                name: 'Bob',
                customerId: 'cust-1',
                accountType: 'basic',
              },
            },
          )
          .then(() => {
            const update = mockMethods.updateOne.mock.calls[0][2];
            expect(update.$set.name.__encrypted).toBe(true);
            expect(update.$set.name.ctx).toBe('personal');
            expect(update.$set.accountType).toBe('basic');
          });
      }));

    test('looks up subjectField from filter when not in $set', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateOne(
            'customers',
            { customerId: 'cust-1' },
            { $set: { name: 'Bob' } },
          )
          .then(() => {
            const update = mockMethods.updateOne.mock.calls[0][2];
            expect(update.$set.name.__encrypted).toBe(true);
            expect(update.$set.name.kid).toBe('cust-1');
          });
      }));

    test('encrypts direct update object (no $ operators)', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateOne(
            'customers',
            { customerId: 'cust-1' },
            { name: 'Bob', customerId: 'cust-1' },
          )
          .then(() => {
            const update = mockMethods.updateOne.mock.calls[0][2];
            expect(update.name.__encrypted).toBe(true);
          });
      }));

    test('passes through update with only non-$set operators', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateOne(
            'customers',
            { customerId: 'cust-1' },
            { $inc: { visits: 1 } },
          )
          .then(() => {
            const update = mockMethods.updateOne.mock.calls[0][2];
            expect(update).toEqual({ $inc: { visits: 1 } });
          });
      }));

    test('preserves additional options args', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateOne(
            'customers',
            { customerId: 'cust-1' },
            { $set: { customerId: 'cust-1', name: 'Bob' } },
            { upsert: true },
          )
          .then(() => {
            expect(mockMethods.updateOne.mock.calls[0][3]).toEqual({
              upsert: true,
            });
          });
      }));
  });

  describe('updateMany', () => {
    test('encrypts PII fields in $set', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .updateMany(
            'customers',
            { accountType: 'premium' },
            {
              $set: {
                location: 'Updated',
                customerId: 'cust-1',
              },
            },
          )
          .then(() => {
            const update = mockMethods.updateMany.mock.calls[0][2];
            expect(update.$set.location.__encrypted).toBe(true);
          });
      }));
  });

  describe('insertMany', () => {
    test('encrypts PII fields in each doc', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .insertMany('customers', [
            {
              customerId: 'cust-1',
              name: 'Alice',
              location: 'Berlin',
            },
            {
              customerId: 'cust-2',
              name: 'Bob',
              location: 'Paris',
            },
          ])
          .then(() => {
            const docs = mockMethods.insertMany.mock.calls[0][1];
            expect(docs[0].name.__encrypted).toBe(true);
            expect(docs[0].name.kid).toBe('cust-1');
            expect(docs[1].name.__encrypted).toBe(true);
            expect(docs[1].name.kid).toBe('cust-2');
          });
      }));
  });

  describe('findOneAndUpdate', () => {
    test('encrypts PII fields in update', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .findOneAndUpdate(
            'customers',
            { customerId: 'cust-1' },
            { $set: { name: 'Carol', customerId: 'cust-1' } },
          )
          .then(() => {
            const update = mockMethods.findOneAndUpdate.mock.calls[0][2];
            expect(update.$set.name.__encrypted).toBe(true);
          });
      }));
  });

  describe('findOneAndReplace', () => {
    test('encrypts PII fields in replacement doc', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .findOneAndReplace(
            'customers',
            { customerId: 'cust-1' },
            {
              customerId: 'cust-1',
              name: 'Dave',
              location: 'Tokyo',
              accountType: 'basic',
            },
          )
          .then(() => {
            const replacement = mockMethods.findOneAndReplace.mock.calls[0][2];
            expect(replacement.name.__encrypted).toBe(true);
            expect(replacement.location.__encrypted).toBe(true);
            expect(replacement.accountType).toBe('basic');
          });
      }));
  });

  describe('bulkWrite', () => {
    test('encrypts fields in insertOne and updateOne operations', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .bulkWrite('customers', [
            {
              insertOne: {
                document: {
                  customerId: 'cust-1',
                  name: 'Alice',
                },
              },
            },
            {
              updateOne: {
                filter: { customerId: 'cust-2' },
                update: {
                  $set: {
                    name: 'Bob',
                    customerId: 'cust-2',
                  },
                },
              },
            },
            {
              deleteOne: { filter: { customerId: 'cust-3' } },
            },
          ])
          .then(() => {
            const ops = mockMethods.bulkWrite.mock.calls[0][1];
            expect(ops[0].insertOne.document.name.__encrypted).toBe(true);
            expect(ops[1].updateOne.update.$set.name.__encrypted).toBe(true);
            expect(ops[2]).toEqual({
              deleteOne: { filter: { customerId: 'cust-3' } },
            });
          });
      }));

    test('encrypts replaceOne operations', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .bulkWrite('customers', [
            {
              replaceOne: {
                filter: { customerId: 'cust-1' },
                replacement: {
                  customerId: 'cust-1',
                  name: 'Eve',
                },
              },
            },
          ])
          .then(() => {
            const ops = mockMethods.bulkWrite.mock.calls[0][1];
            expect(ops[0].replaceOne.replacement.name.__encrypted).toBe(true);
          });
      }));
  });

  describe('pass-through operations', () => {
    test('find passes through unchanged', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        methods.find('customers', { customerId: 'cust-1' });
        expect(mockMethods.find).toHaveBeenCalledWith('customers', {
          customerId: 'cust-1',
        });
      }));

    test('deleteOne passes through unchanged', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .deleteOne('customers', { customerId: 'cust-1' })
          .then(() => {
            expect(mockMethods.deleteOne).toHaveBeenCalledWith('customers', {
              customerId: 'cust-1',
            });
          });
      }));

    test('deleteMany passes through unchanged', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .deleteMany('customers', { accountType: 'trial' })
          .then(() => {
            expect(mockMethods.deleteMany).toHaveBeenCalledWith('customers', {
              accountType: 'trial',
            });
          });
      }));

    test('countDocuments passes through unchanged', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .countDocuments('customers', { accountType: 'premium' })
          .then(() => {
            expect(mockMethods.countDocuments).toHaveBeenCalledWith(
              'customers',
              {
                accountType: 'premium',
              },
            );
          });
      }));

    test('findOneAndDelete passes through unchanged', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .findOneAndDelete('customers', { customerId: 'cust-1' })
          .then(() => {
            expect(mockMethods.findOneAndDelete).toHaveBeenCalledWith(
              'customers',
              {
                customerId: 'cust-1',
              },
            );
          });
      }));
  });

  describe('unknown collection', () => {
    test('passes through documents unchanged for unknown collection', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        const doc = { id: '1', secretData: 'plaintext' };
        return methods.insertOne('unknownCollection', doc).then(() => {
          const inserted = mockMethods.insertOne.mock.calls[0][1];
          expect(inserted.secretData).toBe('plaintext');
        });
      }));
  });

  describe('close and pass-through methods', () => {
    test('close is available on wrapped storage', () =>
      wrappedFactory().then((storage) => {
        expect(storage.close).toBeTypeOf('function');
      }));

    test('updateLastProjectedEventTimestamps is available', () =>
      wrappedFactory().then((storage) => {
        expect(storage.updateLastProjectedEventTimestamps).toBeTypeOf(
          'function',
        );
      }));

    test('readLastProjectedEventTimestamps is available', () =>
      wrappedFactory().then((storage) => {
        expect(storage.readLastProjectedEventTimestamps).toBeTypeOf('function');
      }));
  });

  describe('multiple collections', () => {
    test('uses correct schema per collection', () =>
      wrappedFactory().then((storage) => {
        const methods = storage.perRequest('corr-1');
        return methods
          .insertOne('orderSummaries', {
            orderId: 'ord-1',
            customerId: 'cust-1',
            customerName: 'Alice',
            total: 99.99,
          })
          .then(() => {
            const doc = mockMethods.insertOne.mock.calls[0][1];
            expect(doc.customerName.__encrypted).toBe(true);
            expect(doc.customerName.ctx).toBe('personal');
            expect(doc.total).toBe(99.99);
            expect(doc.orderId).toBe('ord-1');
          });
      }));
  });
});
