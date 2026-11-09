export const NAME_CANONICALIZATION_VERSION = 'nfkc-casefold-whitespace-v1';

/**
 * Byte-identical to the persistence canonicalizer. Keep the version and steps
 * synchronized with web/src/persistence/names.ts; persistence owns the
 * cross-layer source of truth once both workstreams are integrated.
 */
export function canonicalizeName(name: string): string {
  if (typeof name !== 'string') throw new TypeError('Name must be a string');
  return name
    .normalize('NFKC')
    .replace(/ı/g, '\u{F0000}')
    .toUpperCase()
    .toLowerCase()
    .replace(/\u{F0000}/gu, 'ı')
    .replace(/ß/g, 'ss')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}
