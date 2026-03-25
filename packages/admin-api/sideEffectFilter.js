const FILTER_FUNCTIONS = {
  IncludeByName: 'byName',
  ExcludeByName: 'byName',
  IncludeCommand: 'byCommand',
  ExcludeCommand: 'byCommand',
};

const FILTER_TYPES = {
  IncludeByName: 'include',
  ExcludeByName: 'exclude',
  IncludeCommand: 'include',
  ExcludeCommand: 'exclude',
};

const FIELD_KEYS = {
  byName: 'names',
  byCommand: 'commands',
};

// Matches: FunctionName('arg1', 'arg2', ...)
const CALL_PATTERN = /^([A-Za-z]+)\(\s*((?:'[^']*'(?:\s*,\s*'[^']*')*)?)\s*\)$/;

const parseArguments = (argsString) => {
  if (!argsString.trim()) return [];
  const argPattern = /'([^']*)'/g;
  const args = [];
  let match;
  while ((match = argPattern.exec(argsString)) !== null) {
    args.push(match[1]);
  }
  return args;
};

const parseSingleFilter = (filterStr) => {
  const trimmed = filterStr.trim();
  if (!trimmed) return { result: null, error: null };

  const match = trimmed.match(CALL_PATTERN);
  if (!match) {
    return {
      result: null,
      error: `Invalid filter syntax: '${trimmed}'`,
    };
  }

  const funcName = match[1];
  const argsString = match[2];

  if (!FILTER_FUNCTIONS[funcName]) {
    return {
      result: null,
      error: `Unknown filter function: '${funcName}'`,
    };
  }

  const args = parseArguments(argsString);
  if (args.length === 0) {
    return {
      result: null,
      error: `${funcName} requires at least one argument`,
    };
  }

  const emptyArg = args.find((a) => a === '');
  if (emptyArg !== undefined && args.includes('')) {
    return {
      result: null,
      error: `${funcName} contains an empty argument`,
    };
  }

  const category = FILTER_FUNCTIONS[funcName];
  const type = FILTER_TYPES[funcName];
  const key = FIELD_KEYS[category];

  return {
    result: { category, value: { type, [key]: args } },
    error: null,
  };
};

const splitFilters = (filterString) => {
  // Split on && or newline, handling both separators
  const parts = filterString
    .split(/\s*&&\s*|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
};

const parseFilter = (filterString) => {
  if (!filterString || !filterString.trim()) {
    return { filter: null, error: 'Filter string is empty' };
  }

  const parts = splitFilters(filterString);
  if (parts.length === 0) {
    return { filter: null, error: 'Filter string is empty' };
  }

  const filter = {};
  const seen = {};

  for (const part of parts) {
    const { result, error } = parseSingleFilter(part);
    if (error) return { filter: null, error };
    if (!result) continue;

    const { category, value } = result;
    if (seen[category]) {
      return {
        filter: null,
        error: `Duplicate filter category: only one ${category === 'byName' ? 'ByName' : 'Command'} filter is allowed`,
      };
    }
    seen[category] = true;
    filter[category] = value;
  }

  if (Object.keys(filter).length === 0) {
    return { filter: null, error: 'No valid filters found' };
  }

  return { filter, error: null };
};

export { parseFilter };

export const __testing__ = {
  parseSingleFilter,
  parseArguments,
  splitFilters,
};
