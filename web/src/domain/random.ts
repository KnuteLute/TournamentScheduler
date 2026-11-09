/** Stable 32-bit FNV-1a hash used to seed generation and tie ordering. */
export function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Mulberry32 PRNG. Callers must provide the persisted seed; no ambient randomness is used. */
export function createSeededRandom(seed: string, namespace = ''): () => number {
  let state = hash32(`${seed}\u0000${namespace}`);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededOrder<T>(items: readonly T[], seed: string, namespace: string, key: (item: T) => string): T[] {
  return items.slice().sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    const leftHash = hash32(`${seed}\u0000${namespace}\u0000${leftKey}`);
    const rightHash = hash32(`${seed}\u0000${namespace}\u0000${rightKey}`);
    return leftHash - rightHash || compareText(leftKey, rightKey);
  });
}

export function seededShuffle<T>(items: readonly T[], seed: string, namespace: string): T[] {
  const result = items.slice();
  const random = createSeededRandom(seed, namespace);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}
