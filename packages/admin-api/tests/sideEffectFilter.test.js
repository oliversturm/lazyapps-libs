import { describe, test, expect } from 'vitest';
import { parseFilter, __testing__ } from '../sideEffectFilter.js';

const { parseSingleFilter, parseArguments, splitFilters } = __testing__;

describe('parseArguments', () => {
  test('parses single argument', () => {
    expect(parseArguments("'effect1'")).toEqual(['effect1']);
  });

  test('parses multiple arguments', () => {
    expect(parseArguments("'a', 'b', 'c'")).toEqual(['a', 'b', 'c']);
  });

  test('returns empty array for empty string', () => {
    expect(parseArguments('')).toEqual([]);
  });

  test('handles whitespace between arguments', () => {
    expect(parseArguments("'a' ,  'b'")).toEqual(['a', 'b']);
  });
});

describe('splitFilters', () => {
  test('splits on &&', () => {
    expect(splitFilters("IncludeByName('a') && ExcludeCommand('CMD')")).toEqual(
      ["IncludeByName('a')", "ExcludeCommand('CMD')"],
    );
  });

  test('splits on newline', () => {
    expect(splitFilters("IncludeByName('a')\nExcludeCommand('CMD')")).toEqual([
      "IncludeByName('a')",
      "ExcludeCommand('CMD')",
    ]);
  });

  test('handles extra whitespace around &&', () => {
    expect(
      splitFilters("IncludeByName('a')  &&  ExcludeCommand('CMD')"),
    ).toEqual(["IncludeByName('a')", "ExcludeCommand('CMD')"]);
  });

  test('ignores empty parts', () => {
    expect(splitFilters("IncludeByName('a') && ")).toEqual([
      "IncludeByName('a')",
    ]);
  });
});

describe('parseSingleFilter', () => {
  test('parses IncludeByName with one arg', () => {
    const { result, error } = parseSingleFilter("IncludeByName('effect1')");
    expect(error).toBeNull();
    expect(result).toEqual({
      category: 'byName',
      value: { type: 'include', names: ['effect1'] },
    });
  });

  test('parses ExcludeByName with multiple args', () => {
    const { result, error } = parseSingleFilter("ExcludeByName('a', 'b', 'c')");
    expect(error).toBeNull();
    expect(result).toEqual({
      category: 'byName',
      value: { type: 'exclude', names: ['a', 'b', 'c'] },
    });
  });

  test('parses IncludeCommand', () => {
    const { result, error } = parseSingleFilter(
      "IncludeCommand('RECORD_VALUE')",
    );
    expect(error).toBeNull();
    expect(result).toEqual({
      category: 'byCommand',
      value: { type: 'include', commands: ['RECORD_VALUE'] },
    });
  });

  test('parses ExcludeCommand with multiple args', () => {
    const { result, error } = parseSingleFilter(
      "ExcludeCommand('CMD1', 'CMD2')",
    );
    expect(error).toBeNull();
    expect(result).toEqual({
      category: 'byCommand',
      value: { type: 'exclude', commands: ['CMD1', 'CMD2'] },
    });
  });

  test('returns null for empty string', () => {
    const { result, error } = parseSingleFilter('');
    expect(error).toBeNull();
    expect(result).toBeNull();
  });

  test('returns error for unknown function', () => {
    const { result, error } = parseSingleFilter("UnknownFunc('a')");
    expect(result).toBeNull();
    expect(error).toBe("Unknown filter function: 'UnknownFunc'");
  });

  test('returns error for missing arguments', () => {
    const { result, error } = parseSingleFilter('IncludeByName()');
    expect(result).toBeNull();
    expect(error).toBe('IncludeByName requires at least one argument');
  });

  test('returns error for malformed syntax', () => {
    const { result, error } = parseSingleFilter('IncludeByName[a]');
    expect(result).toBeNull();
    expect(error).toContain('Invalid filter syntax');
  });

  test('returns error for empty argument', () => {
    const { result, error } = parseSingleFilter("IncludeByName('')");
    expect(result).toBeNull();
    expect(error).toBe('IncludeByName contains an empty argument');
  });

  test('handles whitespace around call', () => {
    const { result, error } = parseSingleFilter("  IncludeByName('effect1')  ");
    expect(error).toBeNull();
    expect(result.value.names).toEqual(['effect1']);
  });
});

describe('parseFilter', () => {
  describe('single filters', () => {
    test('IncludeByName with one argument', () => {
      const { filter, error } = parseFilter("IncludeByName('effect1')");
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'include', names: ['effect1'] },
      });
    });

    test('IncludeByName with two arguments', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('effect1', 'effect2')",
      );
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'include', names: ['effect1', 'effect2'] },
      });
    });

    test('IncludeByName with three arguments', () => {
      const { filter, error } = parseFilter("IncludeByName('a', 'b', 'c')");
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['a', 'b', 'c']);
    });

    test('ExcludeByName with one argument', () => {
      const { filter, error } = parseFilter("ExcludeByName('effect1')");
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'exclude', names: ['effect1'] },
      });
    });

    test('ExcludeByName with two arguments', () => {
      const { filter, error } = parseFilter("ExcludeByName('a', 'b')");
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['a', 'b']);
    });

    test('IncludeCommand with one argument', () => {
      const { filter, error } = parseFilter("IncludeCommand('RECORD_VALUE')");
      expect(error).toBeNull();
      expect(filter).toEqual({
        byCommand: { type: 'include', commands: ['RECORD_VALUE'] },
      });
    });

    test('IncludeCommand with two arguments', () => {
      const { filter, error } = parseFilter("IncludeCommand('CMD1', 'CMD2')");
      expect(error).toBeNull();
      expect(filter.byCommand.commands).toEqual(['CMD1', 'CMD2']);
    });

    test('IncludeCommand with three arguments', () => {
      const { filter, error } = parseFilter("IncludeCommand('A', 'B', 'C')");
      expect(error).toBeNull();
      expect(filter.byCommand.commands).toEqual(['A', 'B', 'C']);
    });

    test('ExcludeCommand with one argument', () => {
      const { filter, error } = parseFilter("ExcludeCommand('CMD')");
      expect(error).toBeNull();
      expect(filter).toEqual({
        byCommand: { type: 'exclude', commands: ['CMD'] },
      });
    });

    test('ExcludeCommand with two arguments', () => {
      const { filter, error } = parseFilter("ExcludeCommand('CMD1', 'CMD2')");
      expect(error).toBeNull();
      expect(filter.byCommand.commands).toEqual(['CMD1', 'CMD2']);
    });

    test('ExcludeCommand with three arguments', () => {
      const { filter, error } = parseFilter("ExcludeCommand('A', 'B', 'C')");
      expect(error).toBeNull();
      expect(filter.byCommand.commands).toEqual(['A', 'B', 'C']);
    });
  });

  describe('combined filters with &&', () => {
    test('IncludeByName && IncludeCommand', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('effect1') && IncludeCommand('CMD')",
      );
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'include', names: ['effect1'] },
        byCommand: { type: 'include', commands: ['CMD'] },
      });
    });

    test('ExcludeByName && IncludeCommand', () => {
      const { filter, error } = parseFilter(
        "ExcludeByName('effect1') && IncludeCommand('RECORD_VALUE')",
      );
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'exclude', names: ['effect1'] },
        byCommand: { type: 'include', commands: ['RECORD_VALUE'] },
      });
    });

    test('IncludeByName && ExcludeCommand', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('a', 'b') && ExcludeCommand('CMD1', 'CMD2')",
      );
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['a', 'b']);
      expect(filter.byCommand.commands).toEqual(['CMD1', 'CMD2']);
    });
  });

  describe('combined filters with newline', () => {
    test('IncludeByName newline ExcludeCommand', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('effect1')\nExcludeCommand('CMD')",
      );
      expect(error).toBeNull();
      expect(filter).toEqual({
        byName: { type: 'include', names: ['effect1'] },
        byCommand: { type: 'exclude', commands: ['CMD'] },
      });
    });

    test('ExcludeByName newline IncludeCommand', () => {
      const { filter, error } = parseFilter(
        "ExcludeByName('a')\nIncludeCommand('RECORD_VALUE')",
      );
      expect(error).toBeNull();
      expect(filter.byName.type).toBe('exclude');
      expect(filter.byCommand.type).toBe('include');
    });
  });

  describe('error cases', () => {
    test('empty string', () => {
      const { filter, error } = parseFilter('');
      expect(filter).toBeNull();
      expect(error).toBe('Filter string is empty');
    });

    test('null input', () => {
      const { filter, error } = parseFilter(null);
      expect(filter).toBeNull();
      expect(error).toBe('Filter string is empty');
    });

    test('undefined input', () => {
      const { filter, error } = parseFilter(undefined);
      expect(filter).toBeNull();
      expect(error).toBe('Filter string is empty');
    });

    test('whitespace only', () => {
      const { filter, error } = parseFilter('   ');
      expect(filter).toBeNull();
      expect(error).toBe('Filter string is empty');
    });

    test('duplicate ByName filters (Include + Exclude)', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('a') && ExcludeByName('b')",
      );
      expect(filter).toBeNull();
      expect(error).toContain('Duplicate filter category');
      expect(error).toContain('ByName');
    });

    test('duplicate ByName filters (Include + Include)', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('a') && IncludeByName('b')",
      );
      expect(filter).toBeNull();
      expect(error).toContain('Duplicate filter category');
    });

    test('duplicate Command filters (Include + Exclude)', () => {
      const { filter, error } = parseFilter(
        "IncludeCommand('A') && ExcludeCommand('B')",
      );
      expect(filter).toBeNull();
      expect(error).toContain('Duplicate filter category');
      expect(error).toContain('Command');
    });

    test('duplicate Command filters (Exclude + Exclude)', () => {
      const { filter, error } = parseFilter(
        "ExcludeCommand('A') && ExcludeCommand('B')",
      );
      expect(filter).toBeNull();
      expect(error).toContain('Duplicate filter category');
    });

    test('unknown function name', () => {
      const { filter, error } = parseFilter("FilterByType('x')");
      expect(filter).toBeNull();
      expect(error).toContain('Unknown filter function');
    });

    test('missing arguments', () => {
      const { filter, error } = parseFilter('IncludeByName()');
      expect(filter).toBeNull();
      expect(error).toContain('requires at least one argument');
    });

    test('malformed quotes (double quotes)', () => {
      const { filter, error } = parseFilter('IncludeByName("effect1")');
      expect(filter).toBeNull();
      expect(error).toContain('Invalid filter syntax');
    });

    test('missing parentheses', () => {
      const { filter, error } = parseFilter("IncludeByName 'effect1'");
      expect(filter).toBeNull();
      expect(error).toContain('Invalid filter syntax');
    });

    test('no closing paren', () => {
      const { filter, error } = parseFilter("IncludeByName('effect1'");
      expect(filter).toBeNull();
      expect(error).toContain('Invalid filter syntax');
    });

    test('empty argument in list', () => {
      const { filter, error } = parseFilter("IncludeByName('a', '')");
      expect(filter).toBeNull();
      expect(error).toContain('empty argument');
    });
  });

  describe('edge cases', () => {
    test('extra whitespace around filter', () => {
      const { filter, error } = parseFilter("  IncludeByName('effect1')  ");
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['effect1']);
    });

    test('argument names with special characters', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('my-effect_1', 'effect.two')",
      );
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['my-effect_1', 'effect.two']);
    });

    test('command names with underscores', () => {
      const { filter, error } = parseFilter(
        "IncludeCommand('RECORD_VALUE', 'DELETE_ITEM')",
      );
      expect(error).toBeNull();
      expect(filter.byCommand.commands).toEqual([
        'RECORD_VALUE',
        'DELETE_ITEM',
      ]);
    });

    test('combination via newline with duplicate ByName rejects', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('a')\nExcludeByName('b')",
      );
      expect(filter).toBeNull();
      expect(error).toContain('Duplicate filter category');
    });

    test('whitespace in arguments is preserved', () => {
      const { filter, error } = parseFilter(
        "IncludeByName('effect with spaces')",
      );
      expect(error).toBeNull();
      expect(filter.byName.names).toEqual(['effect with spaces']);
    });
  });
});
