export const getNestedValue = (obj, path) =>
  path.split('.').reduce((current, key) => current && current[key], obj);

export const setNestedValue = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((current, key) => {
    if (!current[key]) current[key] = {};
    return current[key];
  }, obj);
  target[last] = value;
  return obj;
};
