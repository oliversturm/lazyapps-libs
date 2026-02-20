# @lazyapps/encryption

Field-level encryption for event-sourced applications. Encrypts sensitive
fields in events before storage and decrypts them on read, with envelope
encryption (DEK/KEK separation), pluggable key stores, and built-in support
for crypto-shredding (GDPR "right to be forgotten").

## Quick Start

```javascript
import {
  createEncryption,
  defineEncryptionSchema,
  inMemoryKeyStore,
} from '@lazyapps/encryption';
import { start } from '@lazyapps/bootstrap';

const schema = defineEncryptionSchema({
  CUSTOMER_CREATED: {
    'payload.name': { context: 'personal', subjectField: 'aggregateId' },
    'payload.email': { context: 'personal', subjectField: 'aggregateId' },
  },
});

const encryption = createEncryption({
  schema,
  keyStore: inMemoryKeyStore({
    personal: crypto.randomBytes(32),
  }),
  contexts: {
    personal: { roles: ['admin', 'support', 'self'] },
  },
});

start({
  encryption,
  commands: { /* ... */ },
});
```

Bootstrap automatically wires encryption into the event store (encrypt on
write, decrypt on replay) and event bus (encrypt before publish). No changes
to aggregates, read model projections, or command handlers are needed.

## How It Works

### Envelope Encryption

Each sensitive field is encrypted with its own **Data Encryption Key (DEK)**,
unique per subject (e.g., per customer). DEKs are wrapped (encrypted) by a
**Key Encryption Key (KEK)** managed by the key store. This two-layer design
means:

- Rotating a KEK does not require re-encrypting all data
- Deleting a subject's DEKs renders their data permanently unreadable
  (crypto-shredding)
- Different encryption contexts can have different KEKs with different access
  policies

### Encrypted Field Format

Encrypted fields in events are replaced with an envelope object:

```javascript
{
  __encrypted: true,
  alg: 'aes-256-gcm',
  iv: '<base64>',
  data: '<base64>',
  tag: '<base64>',
  ctx: 'personal',      // encryption context name
  kid: '<subjectId>',   // which subject's DEK was used
  kv: 1                 // DEK version
}
```

## Key Store Tiers

The `keyStore` parameter controls where KEKs live and how DEKs are
wrapped/unwrapped. Three tiers are available, each suited to different
deployment scenarios.

### Tier 1: In-Memory (Development / Testing)

KEKs are provided directly as buffers. DEKs are stored in a local Map.
Suitable for unit tests and single-process development.

```javascript
import { inMemoryKeyStore } from '@lazyapps/encryption';

const keyStore = inMemoryKeyStore({
  personal: crypto.randomBytes(32),
  financial: crypto.randomBytes(32),
});
```

### Tier 2: MongoDB (Self-Hosted Production)

KEKs are derived from a root secret via HMAC-SHA256. DEKs are stored in a
MongoDB collection. Suitable for deployments where a dedicated KMS is not
available.

```javascript
import { mongoKeyStore } from '@lazyapps/encryption';

const keyStore = mongoKeyStore({
  url: process.env.MONGO_URL,
  rootSecret: process.env.ENCRYPTION_ROOT_SECRET,
  database: 'encryption-keys',
  dekCollection: 'deks',
});
```

**Security note**: The root secret is a single point of compromise. Any service
with the root secret can derive all KEKs. Use environment variables or Docker
secrets to provide it, and consider Tier 3 for production deployments with
compliance requirements.

### Tier 3: Vault / OpenBao (Production)

KEKs live inside HashiCorp Vault (or OpenBao, the Apache 2.0 fork). All key
wrapping and unwrapping happens inside Vault via the transit secrets engine.
Services never see KEKs — they authenticate with AppRole credentials and Vault
policies control which encryption contexts each service can access.

```javascript
import { vaultKeyStore, appRole } from '@lazyapps/encryption';

const keyStore = vaultKeyStore({
  vaultUrl: process.env.VAULT_ADDR,
  authMethod: appRole({
    roleId: process.env.VAULT_ROLE_ID,
    secretId: process.env.VAULT_SECRET_ID,
  }),
});
```

Optionally, DEK metadata can be persisted to MongoDB instead of in-memory
storage using the `dekBackend` option:

```javascript
const keyStore = vaultKeyStore({
  vaultUrl: process.env.VAULT_ADDR,
  authMethod: appRole({ roleId, secretId }),
  dekBackend: {
    url: process.env.MONGO_URL,
    database: 'encryption-keys',
    collection: 'deks',
  },
});
```

You can also authenticate with a token directly (useful for dev mode):

```javascript
const keyStore = vaultKeyStore({
  vaultUrl: 'http://localhost:8200',
  token: 'dev-root-token',
});
```

## Schema Definition

The encryption schema declares which event fields to encrypt, which encryption
context protects them, and which event field identifies the subject (the entity
whose data is being protected).

```javascript
import { defineEncryptionSchema } from '@lazyapps/encryption';

const schema = defineEncryptionSchema({
  CUSTOMER_CREATED: {
    'payload.name': { context: 'personal', subjectField: 'aggregateId' },
    'payload.location': { context: 'personal', subjectField: 'aggregateId' },
  },
  ORDER_CREATED: {
    'payload.text': {
      context: 'order-details',
      subjectField: 'payload.customerId',
    },
  },
});
```

- **Field paths** use dot notation (e.g., `'payload.name'`)
- **`context`**: Names the encryption context (must match a key in the key
  store and the `contexts` configuration)
- **`subjectField`**: Dot-notation path to the field in the event that
  identifies the data subject. The DEK is keyed by this value.

## Encryption Contexts

Contexts define access control — which roles can decrypt fields protected by
each context:

```javascript
const contexts = {
  personal: { roles: ['admin', 'support', 'self'] },
  financial: { roles: ['admin', 'finance'] },
  'order-details': { roles: ['admin', 'support', 'sales'] },
};
```

The `'self'` role is special: it grants access when the requesting identity
matches the data subject.

## Bootstrap Integration

Pass the `encryption` promise to `start()`. Bootstrap handles wiring:

```javascript
const encryption = createEncryption({ schema, keyStore, contexts });

// Command processor: wraps eventStore (encrypt) and eventBus (encrypt)
start({
  encryption,
  commands: { eventStore: mongodb(...), eventBus: rabbitMq(...), ... },
});

// Read model: wraps storage (encrypt on write) and creates projection decryptor
start({
  encryption,
  readModels: {
    role: 'customer-service',
    storage: mongodb(...),
    ...
  },
});
```

### What Bootstrap Does

For command processors (`commands` config):
- **Event store**: Events are encrypted before `addEvent` and decrypted during
  `replay` (so aggregate projections see plaintext)
- **Event bus**: Events are encrypted before `publishEvent` (if not already
  encrypted by the event store wrapper)

For read models (`readModels` config):
- **Projection decryptor**: Created via `createProjectionDecryptor(role)`,
  decrypts events before projection handlers see them. Falls back to
  `'[deleted]'` if DEKs are unavailable (crypto-shredded)
- **Storage**: If `readModelEncryption` is configured, wraps storage operations
  to encrypt sensitive fields on write (insertOne, updateOne, etc.)

## Read Model Encryption

To encrypt fields stored in read model collections (not just event fields),
provide a `readModelEncryption` configuration:

```javascript
const encryption = createEncryption({
  schema,
  keyStore,
  contexts,
  readModelEncryption: {
    customers: {
      name: { context: 'personal', subjectField: 'customerId' },
      location: { context: 'personal', subjectField: 'customerId' },
    },
    orderSummaries: {
      customerName: { context: 'personal', subjectField: 'customerId' },
    },
  },
});
```

The storage wrapper intercepts `insertOne`, `updateOne`, `updateMany`,
`findOneAndUpdate`, `findOneAndReplace`, and `bulkWrite` calls, encrypting the
specified fields before they reach the database.

## Crypto-Shredding (Forget Subject)

To make a subject's data permanently unreadable, delete their DEKs:

```javascript
// Via the encryption module directly
encryption.then((enc) => enc.forgetSubject(subjectId));
```

After DEK deletion:
- Encrypted events in the event store become undecryptable
- Projection handlers receive fallback values (`'[deleted]'` by default)
- Read model queries return fallback values for encrypted fields

### Integration with Event Sourcing

The recommended pattern is a `FORGET_SUBJECT` command and `SUBJECT_FORGOTTEN`
event. The encryption module's event store wrapper automatically deletes DEKs
when it processes a `SUBJECT_FORGOTTEN` event. Read model projections should
handle `SUBJECT_FORGOTTEN` by cleaning up the subject's records.

```javascript
// SubjectLifecycle aggregate
export default {
  initial: () => ({}),
  commands: {
    FORGET_SUBJECT: (aggregate, payload) => ({
      type: 'SUBJECT_FORGOTTEN',
      payload,
    }),
  },
  projections: {
    SUBJECT_FORGOTTEN: (aggregate) => ({ ...aggregate, forgotten: true }),
  },
};
```

## Key Rotation

Vault key stores support KEK rotation:

```javascript
encryption.then((enc) => enc.rotateContextKey('personal'));
```

This rotates the transit key in Vault. New DEKs will be wrapped with the new
key version. Existing wrapped DEKs can still be unwrapped (Vault supports key
versioning).

## API Reference

### `createEncryption(options)`

Returns a Promise that resolves to the encryption module.

**Options**:
- `schema` — Result of `defineEncryptionSchema()`
- `keyStore` — Key store instance (`inMemoryKeyStore()`, `mongoKeyStore()`,
  or `vaultKeyStore()`)
- `contexts` — Object mapping context names to `{ roles: string[] }`
- `readModelEncryption` — Optional read model field encryption config
- `cache` — Optional `{ maxSize: number, ttlMs: number }` (default:
  `{ maxSize: 10000, ttlMs: 300000 }`)
- `fallbackValue` — Value used when decryption fails (default: `'[deleted]'`)

**Resolved object methods**:
- `wrapEventStore(eventStoreFactory)` — Returns a wrapped factory that
  encrypts/decrypts events
- `wrapEventBus(eventBusFactory)` — Returns a wrapped factory that encrypts
  events before publishing
- `createProjectionDecryptor(role)` — Returns `(event) => Promise<event>` that
  decrypts event fields for the given role
- `wrapStorage(storageFactory)` — Returns a wrapped factory that encrypts
  read model fields on write
- `createQueryDecryptor()` — Returns a decryptor for query results with
  role-based access control
- `forgetSubject(subjectId)` — Deletes all DEKs for a subject
  (crypto-shredding)
- `rotateContextKey(contextName)` — Rotates the KEK for a context (Vault only)
- `getSchema()` — Returns the encryption schema
- `getContexts()` — Returns the contexts configuration

### `defineEncryptionSchema(schemaDef)`

Validates and returns the schema definition. Throws if any field is missing
`context` or `subjectField`.

### `inMemoryKeyStore(initialKEKs)`

Creates an in-memory key store. `initialKEKs` is an object mapping context
names to 32-byte Buffer or base64-encoded key strings.

### `mongoKeyStore(options)`

Creates a MongoDB-backed key store.

- `url` — MongoDB connection URL
- `rootSecret` — 32-byte Buffer or base64 string used to derive KEKs
- `database` — Database name (default: `'encryption-keys'`)
- `dekCollection` — Collection name (default: `'deks'`)

### `vaultKeyStore(options)`

Creates a Vault/OpenBao-backed key store.

- `vaultUrl` — Vault server URL
- `token` — Direct token authentication (for dev mode)
- `authMethod` — Authentication method (e.g., `appRole()`)
- `dekBackend` — Optional `{ url, database, collection }` for MongoDB-backed
  DEK storage

### `appRole(options)`

Creates an AppRole authentication method for Vault.

- `roleId` — AppRole role ID
- `secretId` — AppRole secret ID
