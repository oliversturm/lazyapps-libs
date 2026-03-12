import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  }),
}));

const { createApiHandler } = await import('../readmodels/query.js');
const { encryptValue } = await import('../../encryption/fieldEncryption.js');
const { inMemoryKeyStore } =
  await import('../../encryption/keystores/inmemory.js');
const { createEnvelopeManager } =
  await import('../../encryption/envelopeEncryption.js');
const { defineEncryptionSchema } = await import('../../encryption/schema.js');
const { createQueryDecryptor } =
  await import('../../encryption/queryDecryptor.js');
const { directRoleMapper } = await import('../../encryption/jwtScopeMapper.js');

const personalKEK = randomBytes(32);
const contactKEK = randomBytes(32);

const contexts = {
  personal: { roles: ['admin', 'hr', 'self'] },
  contact: { roles: ['admin', 'support'] },
};

const readModelEncryption = {
  customers: {
    name: { context: 'personal', subjectField: 'customerId' },
    email: { context: 'contact', subjectField: 'customerId' },
  },
};

const schema = defineEncryptionSchema({
  contexts: {
    personal: {
      unauthorizedText: '[personal data restricted]',
      forgottenText: '[personal data deleted]',
    },
    contact: {
      unauthorizedText: '[contact data restricted]',
    },
  },
  events: {},
});

const mockReq = (body = {}, auth = undefined) => ({
  body: { correlationId: 'corr-test', ...body },
  params: {},
  auth,
  headers: {},
  cookies: {},
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  return res;
};

// Build an encrypted document the way a read model would store it.
const makeEncryptedDoc = (envelope, fields) => {
  const doc = {};
  const toEncrypt = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.__shouldEncrypt) {
      toEncrypt.push([key, value]);
    } else {
      doc[key] = value;
    }
  }
  return toEncrypt.reduce(
    (promise, [fieldName, config]) =>
      promise.then((d) =>
        envelope.getDEK(config.kid, config.ctx).then((dek) => ({
          ...d,
          [fieldName]: {
            ...encryptValue(dek.key, config.plaintext),
            ctx: config.ctx,
            kid: config.kid,
            kv: dek.version,
            wk: dek.wrappedKey,
          },
        })),
      ),
    Promise.resolve(doc),
  );
};

describe('query decryption integration (multi-role)', () => {
  let envelope;
  let queryDecryptor;

  beforeEach(() =>
    inMemoryKeyStore({ personal: personalKEK, contact: contactKEK })
      .initialize()
      .then((ks) => {
        envelope = createEnvelopeManager(ks, contexts);
        queryDecryptor = createQueryDecryptor(
          readModelEncryption,
          envelope,
          schema,
          contexts,
        );
      }),
  );

  test('admin token sees decrypted PII, public token sees unauthorized placeholders', () => {
    const jwtScopeMapper = directRoleMapper();

    return makeEncryptedDoc(envelope, {
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'alice@example.com',
        ctx: 'contact',
        kid: 'cust-1',
      },
      accountType: 'premium',
    }).then((encryptedDoc) => {
      // Resolver returns the same encrypted document for all queries
      const resolver = vi.fn().mockResolvedValue(encryptedDoc);
      const context = {
        storage: { perRequest: vi.fn().mockReturnValue('storage') },
        encryptionQueryDecryptor: queryDecryptor,
        jwtScopeMapper,
      };

      const handler = createApiHandler(context)(
        'customers',
        {},
        'byId',
        resolver,
      );

      // --- Admin query: has roles that grant access to both contexts ---
      const adminAuth = { sub: 'admin-user', roles: ['admin'] };
      const adminReq = mockReq({}, adminAuth);
      const adminRes = mockRes();

      // --- Public query: no matching roles ---
      const publicAuth = { sub: 'public-user', roles: ['visitor'] };
      const publicReq = mockReq({}, publicAuth);
      const publicRes = mockRes();

      return handler(adminReq, adminRes)
        .then(() => handler(publicReq, publicRes))
        .then(() => {
          // Admin sees all decrypted fields
          expect(adminRes.status).toHaveBeenCalledWith(200);
          const adminData = adminRes.json.mock.calls[0][0];
          expect(adminData.name).toBe('Alice');
          expect(adminData.email).toBe('alice@example.com');
          expect(adminData.accountType).toBe('premium');

          // Public user sees unauthorized placeholders
          expect(publicRes.status).toHaveBeenCalledWith(200);
          const publicData = publicRes.json.mock.calls[0][0];
          expect(publicData.name).toEqual({
            unauthorized: true,
            text: '[personal data restricted]',
          });
          expect(publicData.email).toEqual({
            unauthorized: true,
            text: '[contact data restricted]',
          });
          // Non-encrypted field is still visible
          expect(publicData.accountType).toBe('premium');
        });
    });
  });

  test('partial-access token: hr role sees personal but not contact data', () => {
    const jwtScopeMapper = directRoleMapper();

    return makeEncryptedDoc(envelope, {
      customerId: 'cust-2',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Bob',
        ctx: 'personal',
        kid: 'cust-2',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'bob@example.com',
        ctx: 'contact',
        kid: 'cust-2',
      },
    }).then((encryptedDoc) => {
      const resolver = vi.fn().mockResolvedValue(encryptedDoc);
      const context = {
        storage: { perRequest: vi.fn().mockReturnValue('storage') },
        encryptionQueryDecryptor: queryDecryptor,
        jwtScopeMapper,
      };

      const handler = createApiHandler(context)(
        'customers',
        {},
        'byId',
        resolver,
      );

      // HR role: in personal.roles but not in contact.roles
      const hrAuth = { sub: 'hr-user', roles: ['hr'] };
      const hrReq = mockReq({}, hrAuth);
      const hrRes = mockRes();

      return handler(hrReq, hrRes).then(() => {
        expect(hrRes.status).toHaveBeenCalledWith(200);
        const data = hrRes.json.mock.calls[0][0];
        expect(data.name).toBe('Bob');
        expect(data.email).toEqual({
          unauthorized: true,
          text: '[contact data restricted]',
        });
      });
    });
  });

  test('array results: each document decrypted per-token scopes', () => {
    const jwtScopeMapper = directRoleMapper();

    return Promise.all([
      makeEncryptedDoc(envelope, {
        customerId: 'cust-1',
        name: {
          __shouldEncrypt: true,
          plaintext: 'Alice',
          ctx: 'personal',
          kid: 'cust-1',
        },
      }),
      makeEncryptedDoc(envelope, {
        customerId: 'cust-2',
        name: {
          __shouldEncrypt: true,
          plaintext: 'Bob',
          ctx: 'personal',
          kid: 'cust-2',
        },
      }),
    ]).then(([doc1, doc2]) => {
      const resolver = vi.fn().mockResolvedValue([doc1, doc2]);
      const context = {
        storage: { perRequest: vi.fn().mockReturnValue('storage') },
        encryptionQueryDecryptor: queryDecryptor,
        jwtScopeMapper,
      };

      const handler = createApiHandler(context)(
        'customers',
        {},
        'all',
        resolver,
      );

      // Admin sees decrypted array
      const adminReq = mockReq({}, { sub: 'admin-user', roles: ['admin'] });
      const adminRes = mockRes();

      // Visitor sees restricted array
      const visitorReq = mockReq({}, { sub: 'visitor', roles: ['visitor'] });
      const visitorRes = mockRes();

      return handler(adminReq, adminRes)
        .then(() => handler(visitorReq, visitorRes))
        .then(() => {
          const adminData = adminRes.json.mock.calls[0][0];
          expect(adminData).toHaveLength(2);
          expect(adminData[0].name).toBe('Alice');
          expect(adminData[1].name).toBe('Bob');

          const visitorData = visitorRes.json.mock.calls[0][0];
          expect(visitorData).toHaveLength(2);
          expect(visitorData[0].name).toEqual({
            unauthorized: true,
            text: '[personal data restricted]',
          });
          expect(visitorData[1].name).toEqual({
            unauthorized: true,
            text: '[personal data restricted]',
          });
        });
    });
  });

  test('fallback without jwtScopeMapper uses encryptionRole', () =>
    makeEncryptedDoc(envelope, {
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Charlie',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((encryptedDoc) => {
      const resolver = vi.fn().mockResolvedValue(encryptedDoc);
      // No jwtScopeMapper — falls back to encryptionRole
      const context = {
        storage: { perRequest: vi.fn().mockReturnValue('storage') },
        encryptionQueryDecryptor: queryDecryptor,
        encryptionRole: 'admin',
      };

      const handler = createApiHandler(context)(
        'customers',
        {},
        'byId',
        resolver,
      );

      const req = mockReq({});
      const res = mockRes();

      return handler(req, res).then(() => {
        expect(res.status).toHaveBeenCalledWith(200);
        const data = res.json.mock.calls[0][0];
        // admin role grants access to personal context
        expect(data.name).toBe('Charlie');
      });
    }));

  test('self-access: subject can see own personal data without admin role', () => {
    const jwtScopeMapper = directRoleMapper();

    return makeEncryptedDoc(envelope, {
      customerId: 'cust-42',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Diana',
        ctx: 'personal',
        kid: 'cust-42',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'diana@example.com',
        ctx: 'contact',
        kid: 'cust-42',
      },
    }).then((encryptedDoc) => {
      const resolver = vi.fn().mockResolvedValue(encryptedDoc);
      const context = {
        storage: { perRequest: vi.fn().mockReturnValue('storage') },
        encryptionQueryDecryptor: queryDecryptor,
        jwtScopeMapper,
      };

      const handler = createApiHandler(context)(
        'customers',
        {},
        'byId',
        resolver,
      );

      // Self-access: identity matches kid on encrypted field
      // personal context includes 'self' role, contact does not
      const selfAuth = { sub: 'cust-42', roles: ['customer'] };
      const selfReq = mockReq({}, selfAuth);
      const selfRes = mockRes();

      return handler(selfReq, selfRes).then(() => {
        expect(selfRes.status).toHaveBeenCalledWith(200);
        const data = selfRes.json.mock.calls[0][0];
        // personal has 'self' in roles, identity matches kid → decrypted
        expect(data.name).toBe('Diana');
        // contact does NOT have 'self' in roles → restricted
        expect(data.email).toEqual({
          unauthorized: true,
          text: '[contact data restricted]',
        });
      });
    });
  });
});
