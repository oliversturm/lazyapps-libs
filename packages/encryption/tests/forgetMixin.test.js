import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createForgetMixin } = await import('../forgetMixin.js');

describe('createForgetMixin', () => {
  const contexts = {
    personal: { roles: ['admin', 'support'], autoForget: true },
    financial: { roles: ['admin'] },
  };

  const mixin = createForgetMixin(contexts);

  describe('structure', () => {
    test('returns commands object with FORGET_SUBJECT, FORGET_SUBJECT_CONTEXT, FORGET_RELATED_SUBJECT', () => {
      expect(mixin.commands).toHaveProperty('FORGET_SUBJECT');
      expect(mixin.commands).toHaveProperty('FORGET_SUBJECT_CONTEXT');
      expect(mixin.commands).toHaveProperty('FORGET_RELATED_SUBJECT');
      expect(Object.keys(mixin.commands)).toHaveLength(3);
    });

    test('returns projections object with SUBJECT_FORGOTTEN', () => {
      expect(mixin.projections).toHaveProperty('SUBJECT_FORGOTTEN');
      expect(Object.keys(mixin.projections)).toHaveLength(1);
    });

    test('all commands are functions', () => {
      expect(mixin.commands.FORGET_SUBJECT).toBeTypeOf('function');
      expect(mixin.commands.FORGET_SUBJECT_CONTEXT).toBeTypeOf('function');
      expect(mixin.commands.FORGET_RELATED_SUBJECT).toBeTypeOf('function');
    });

    test('SUBJECT_FORGOTTEN projection is a function', () => {
      expect(mixin.projections.SUBJECT_FORGOTTEN).toBeTypeOf('function');
    });
  });

  describe('FORGET_SUBJECT command', () => {
    test('emits SUBJECT_FORGOTTEN with autoForget context names', () => {
      const result = mixin.commands.FORGET_SUBJECT(
        {},
        { subjectId: 'sub-1', reason: 'GDPR', requestedBy: 'admin' },
      );
      expect(result).toEqual({
        type: 'SUBJECT_FORGOTTEN',
        payload: {
          subjectId: 'sub-1',
          reason: 'GDPR',
          requestedBy: 'admin',
          contexts: ['personal'],
        },
      });
    });

    test('includes only contexts with autoForget: true', () => {
      const result = mixin.commands.FORGET_SUBJECT({}, { subjectId: 'sub-2' });
      expect(result.payload.contexts).toEqual(['personal']);
      expect(result.payload.contexts).not.toContain('financial');
    });

    test('throws ValidationError if aggregate is already forgotten', () => {
      expect(() =>
        mixin.commands.FORGET_SUBJECT(
          { forgotten: true },
          { subjectId: 'sub-1' },
        ),
      ).toThrow(/already been forgotten/);
    });

    test('thrown error has name ValidationError', () => {
      try {
        mixin.commands.FORGET_SUBJECT(
          { forgotten: true },
          { subjectId: 'sub-1' },
        );
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err.name).toBe('ValidationError');
      }
    });

    test('throws when no autoForget contexts exist', () => {
      const noAutoMixin = createForgetMixin({
        personal: { roles: ['admin'] },
        financial: { roles: ['admin'] },
      });
      expect(() =>
        noAutoMixin.commands.FORGET_SUBJECT({}, { subjectId: 'sub-1' }),
      ).toThrow(/No contexts with autoForget enabled/);
    });

    test('includes multiple autoForget contexts when configured', () => {
      const multiAutoMixin = createForgetMixin({
        personal: { roles: ['admin'], autoForget: true },
        financial: { roles: ['admin'], autoForget: true },
        analytics: { roles: ['admin'] },
      });
      const result = multiAutoMixin.commands.FORGET_SUBJECT(
        {},
        { subjectId: 'sub-1' },
      );
      expect(result.payload.contexts).toEqual(['personal', 'financial']);
    });
  });

  describe('FORGET_SUBJECT_CONTEXT command', () => {
    test('emits SUBJECT_FORGOTTEN with single context', () => {
      const result = mixin.commands.FORGET_SUBJECT_CONTEXT(
        {},
        { contextName: 'personal' },
      );
      expect(result).toEqual({
        type: 'SUBJECT_FORGOTTEN',
        payload: {
          contextName: 'personal',
          contexts: ['personal'],
        },
      });
    });

    test('throws ValidationError when contextName is missing', () => {
      expect(() => mixin.commands.FORGET_SUBJECT_CONTEXT({}, {})).toThrow(
        /Missing contextName/,
      );
    });

    test('throws when context has already been forgotten', () => {
      expect(() =>
        mixin.commands.FORGET_SUBJECT_CONTEXT(
          { forgottenContexts: ['personal'] },
          { contextName: 'personal' },
        ),
      ).toThrow(/already been forgotten/);
    });

    test('succeeds for a context not yet forgotten', () => {
      const result = mixin.commands.FORGET_SUBJECT_CONTEXT(
        { forgottenContexts: ['financial'] },
        { contextName: 'personal' },
      );
      expect(result.payload.contexts).toEqual(['personal']);
    });
  });

  describe('FORGET_RELATED_SUBJECT command', () => {
    test('emits RELATED_SUBJECT_FORGOTTEN with payload', () => {
      const payload = {
        relatedSubjectId: 'rel-1',
        relatedSubjectType: 'order',
        contexts: ['personal'],
      };
      const result = mixin.commands.FORGET_RELATED_SUBJECT({}, payload);
      expect(result).toEqual({
        type: 'RELATED_SUBJECT_FORGOTTEN',
        payload,
      });
    });

    test('throws when relatedSubjectId is missing', () => {
      expect(() =>
        mixin.commands.FORGET_RELATED_SUBJECT(
          {},
          { relatedSubjectType: 'order', contexts: ['personal'] },
        ),
      ).toThrow(/Missing relatedSubjectId/);
    });

    test('throws when relatedSubjectType is missing', () => {
      expect(() =>
        mixin.commands.FORGET_RELATED_SUBJECT(
          {},
          { relatedSubjectId: 'rel-1', contexts: ['personal'] },
        ),
      ).toThrow(/Missing relatedSubjectType/);
    });

    test('throws when contexts is missing', () => {
      expect(() =>
        mixin.commands.FORGET_RELATED_SUBJECT(
          {},
          { relatedSubjectId: 'rel-1', relatedSubjectType: 'order' },
        ),
      ).toThrow(/Missing contexts/);
    });

    test('throws when contexts is empty array', () => {
      expect(() =>
        mixin.commands.FORGET_RELATED_SUBJECT(
          {},
          {
            relatedSubjectId: 'rel-1',
            relatedSubjectType: 'order',
            contexts: [],
          },
        ),
      ).toThrow(/Missing contexts/);
    });
  });

  describe('SUBJECT_FORGOTTEN projection', () => {
    test('sets forgotten flag and merges contexts', () => {
      const result = mixin.projections.SUBJECT_FORGOTTEN(
        {},
        { payload: { contexts: ['personal'] }, timestamp: 1000 },
      );
      expect(result).toEqual({
        forgotten: true,
        forgottenContexts: ['personal'],
        forgottenAt: 1000,
      });
    });

    test('merges new contexts with existing ones', () => {
      const result = mixin.projections.SUBJECT_FORGOTTEN(
        { forgotten: true, forgottenContexts: ['personal'], forgottenAt: 500 },
        { payload: { contexts: ['financial'] }, timestamp: 1000 },
      );
      expect(result.forgottenContexts).toEqual(['personal', 'financial']);
      expect(result.forgottenAt).toBe(1000);
    });

    test('deduplicates contexts', () => {
      const result = mixin.projections.SUBJECT_FORGOTTEN(
        { forgottenContexts: ['personal'] },
        { payload: { contexts: ['personal', 'financial'] }, timestamp: 1000 },
      );
      expect(result.forgottenContexts).toEqual(['personal', 'financial']);
    });

    test('handles missing contexts in payload gracefully', () => {
      const result = mixin.projections.SUBJECT_FORGOTTEN(
        {},
        { payload: {}, timestamp: 1000 },
      );
      expect(result.forgotten).toBe(true);
      expect(result.forgottenContexts).toEqual([]);
    });

    test('preserves other aggregate state', () => {
      const result = mixin.projections.SUBJECT_FORGOTTEN(
        { name: 'Alice', age: 30 },
        { payload: { contexts: ['personal'] }, timestamp: 1000 },
      );
      expect(result.name).toBe('Alice');
      expect(result.age).toBe(30);
      expect(result.forgotten).toBe(true);
    });
  });
});
