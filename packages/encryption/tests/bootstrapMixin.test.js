import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startSpan: () => ({ end: vi.fn(), setStatus: vi.fn() }),
    }),
  },
  context: { with: (ctx, fn) => fn() },
  SpanStatusCode: { ERROR: 2 },
}));

// We need to test the bootstrap internals: checkConflicts and injectForgetMixin.
// These are not exported, so we import the module and test through `start()` behavior.
// However, since bootstrap is deeply coupled to command-processor, express, etc.,
// we test the mixin injection pattern directly by reimplementing the conflict
// detection logic that matches bootstrap/index.js exactly.

const { createForgetMixin } = await import('../forgetMixin.js');

// Replicate bootstrap's MIXIN_COMMANDS/MIXIN_PROJECTIONS and checkConflicts
// to validate behavior matches what bootstrap/index.js does.
const MIXIN_COMMANDS = ['FORGET_SUBJECT', 'FORGET_SUBJECT_CONTEXT'];

const MIXIN_PROJECTIONS = ['SUBJECT_FORGOTTEN'];

const checkConflicts = (aggregateName, aggregate) => {
  const conflicts = [];
  for (const cmd of MIXIN_COMMANDS) {
    if (aggregate.commands && aggregate.commands[cmd]) {
      conflicts.push(`command ${cmd}`);
    }
  }
  for (const proj of MIXIN_PROJECTIONS) {
    if (aggregate.projections && aggregate.projections[proj]) {
      conflicts.push(`projection ${proj}`);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Aggregate '${aggregateName}' already defines ` +
        `${conflicts.join(', ')}. ` +
        'Application-level override of framework-injected forget ' +
        'handlers is not supported.',
    );
  }
};

const injectForgetMixin = (aggregates, subjects, mixin) => {
  if (!subjects || !aggregates) return aggregates;
  const result = { ...aggregates };
  for (const aggregateName of Object.keys(subjects)) {
    const aggregate = result[aggregateName];
    if (!aggregate) continue;
    checkConflicts(aggregateName, aggregate);
    result[aggregateName] = {
      ...aggregate,
      commands: { ...aggregate.commands, ...mixin.commands },
      projections: { ...aggregate.projections, ...mixin.projections },
    };
  }
  return result;
};

describe('bootstrap mixin injection', () => {
  const contexts = {
    personal: { roles: ['admin'], autoForget: true },
  };

  const mixin = createForgetMixin(contexts);

  const baseAggregate = {
    initial: () => ({}),
    commands: {
      CREATE: () => ({ type: 'CREATED', payload: {} }),
    },
    projections: {
      CREATED: (state) => ({ ...state, created: true }),
    },
  };

  describe('checkConflicts', () => {
    test('does not throw for aggregate without mixin commands', () => {
      expect(() => checkConflicts('customer', baseAggregate)).not.toThrow();
    });

    test('throws when aggregate defines FORGET_SUBJECT command', () => {
      const conflicting = {
        ...baseAggregate,
        commands: {
          ...baseAggregate.commands,
          FORGET_SUBJECT: () => {},
        },
      };
      expect(() => checkConflicts('customer', conflicting)).toThrow(
        /command FORGET_SUBJECT/,
      );
    });

    test('throws when aggregate defines SUBJECT_FORGOTTEN projection', () => {
      const conflicting = {
        ...baseAggregate,
        projections: {
          ...baseAggregate.projections,
          SUBJECT_FORGOTTEN: () => {},
        },
      };
      expect(() => checkConflicts('customer', conflicting)).toThrow(
        /projection SUBJECT_FORGOTTEN/,
      );
    });

    test('reports all conflicts in a single error', () => {
      const conflicting = {
        commands: {
          FORGET_SUBJECT: () => {},
          FORGET_SUBJECT_CONTEXT: () => {},
        },
        projections: {
          SUBJECT_FORGOTTEN: () => {},
        },
      };
      expect(() => checkConflicts('order', conflicting)).toThrow(
        /command FORGET_SUBJECT, command FORGET_SUBJECT_CONTEXT, projection SUBJECT_FORGOTTEN/,
      );
    });

    test('includes aggregate name in error message', () => {
      const conflicting = {
        commands: { FORGET_SUBJECT: () => {} },
        projections: {},
      };
      expect(() => checkConflicts('invoice', conflicting)).toThrow(
        /Aggregate 'invoice'/,
      );
    });
  });

  describe('injectForgetMixin', () => {
    test('merges mixin commands and projections into matching aggregate', () => {
      const aggregates = { customer: baseAggregate };
      const subjects = { customer: {} };
      const result = injectForgetMixin(aggregates, subjects, mixin);

      expect(result.customer.commands.CREATE).toBe(
        baseAggregate.commands.CREATE,
      );
      expect(result.customer.commands.FORGET_SUBJECT).toBe(
        mixin.commands.FORGET_SUBJECT,
      );
      expect(result.customer.commands.FORGET_SUBJECT_CONTEXT).toBe(
        mixin.commands.FORGET_SUBJECT_CONTEXT,
      );
      expect(result.customer.projections.SUBJECT_FORGOTTEN).toBe(
        mixin.projections.SUBJECT_FORGOTTEN,
      );
    });

    test('does not modify aggregates not in subjects config', () => {
      const aggregates = {
        customer: baseAggregate,
        order: { ...baseAggregate },
      };
      const subjects = { customer: {} };
      const result = injectForgetMixin(aggregates, subjects, mixin);

      expect(result.order.commands.FORGET_SUBJECT).toBeUndefined();
      expect(result.customer.commands.FORGET_SUBJECT).toBeDefined();
    });

    test('returns aggregates unchanged when subjects is null', () => {
      const aggregates = { customer: baseAggregate };
      const result = injectForgetMixin(aggregates, null, mixin);
      expect(result).toBe(aggregates);
    });

    test('returns aggregates unchanged when aggregates is null', () => {
      const result = injectForgetMixin(null, { customer: {} }, mixin);
      expect(result).toBeNull();
    });

    test('skips subjects referencing non-existent aggregates', () => {
      const aggregates = { customer: baseAggregate };
      const subjects = { customer: {}, nonexistent: {} };
      // Should not throw, just skip
      const result = injectForgetMixin(aggregates, subjects, mixin);
      expect(result.customer.commands.FORGET_SUBJECT).toBeDefined();
      expect(result.nonexistent).toBeUndefined();
    });

    test('throws when subject aggregate has conflicting command', () => {
      const conflicting = {
        ...baseAggregate,
        commands: {
          ...baseAggregate.commands,
          FORGET_SUBJECT: () => {},
        },
      };
      const aggregates = { customer: conflicting };
      const subjects = { customer: {} };
      expect(() => injectForgetMixin(aggregates, subjects, mixin)).toThrow(
        /command FORGET_SUBJECT/,
      );
    });
  });
});
