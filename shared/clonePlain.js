const MAX_PLAIN_DEPTH = 8;

function cloneAtDepth(value, depth) {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_PLAIN_DEPTH) return structuredClone(value);
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = cloneAtDepth(value[index], depth + 1);
    }
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return structuredClone(value);
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = cloneAtDepth(value[key], depth + 1);
  return copy;
}

export function clonePlain(value) {
  return cloneAtDepth(value, 0);
}
