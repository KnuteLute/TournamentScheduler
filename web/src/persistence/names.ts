export const NAME_CANONICALIZATION_VERSION = 'nfkc-casefold-whitespace-v1';

/**
 * Canonical display-name key shared by repository/import paths.
 * JavaScript does not expose Unicode CaseFolding.txt directly. The stable
 * upper-then-lower transform provides full-fold expansions for common scripts;
 * dotless i is preserved (Unicode default case folding keeps it distinct), and
 * sharp s is expanded explicitly. The version is persisted so a runtime
 * Unicode-table update can be migrated deliberately.
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
