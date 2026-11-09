import { canonicalizeName, NAME_CANONICALIZATION_VERSION } from './names';
import { normalizeDisplayName, validateTournamentInput } from './validation';

describe('display-name canonicalization', () => {
  it('uses the persistence canonicalization version and edge-case corpus', () => {
    const cases: Array<[string, string]> = [
      ['Straße', 'strasse'],
      ['ẞ', 'ss'],
      ['Σ', 'σ'],
      ['ς', 'σ'],
      ['ΟΣ', 'ος'],
      ['οσ', 'ος'],
      ['I', 'i'],
      ['ı', 'ı'],
      ['İ', 'i\u0307'],
      ['ﬃ', 'ffi'],
      ['  A\u00a0\u2009B  ', 'a b'],
      ['ＡＢＣ', 'abc'],
      ['K', 'k'],
      ['x\u200By', 'x\u200By'],
    ];

    expect(NAME_CANONICALIZATION_VERSION).toBe('nfkc-casefold-whitespace-v1');
    cases.forEach(([input, expected]) => {
      expect(canonicalizeName(input)).toBe(expected);
      expect(normalizeDisplayName(input)).toBe(expected);
    });
  });

  it('uses the same canonical keys to reject duplicate participant names', () => {
    const duplicatePairs: Array<[string, string]> = [
      ['Straße', 'STRASSE'],
      ['ΟΣ', 'οσ'],
      ['ﬃ', 'ffi'],
      ['A\u00a0B', 'a b'],
      ['Ａ', 'a'],
    ];

    duplicatePairs.forEach(([first, second]) => {
      const issues = validateTournamentInput('1v1', [
        { id: 'first', name: first },
        { id: 'second', name: second },
      ]);
      expect(issues.some((issue) => issue.code === 'duplicate_name')).toBe(true);
    });
  });

  it('preserves the Unicode case-fold distinction for Turkish dotless i', () => {
    expect(canonicalizeName('I')).not.toBe(canonicalizeName('ı'));
  });
});
