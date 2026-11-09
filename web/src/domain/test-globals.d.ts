interface DomainTestExpect {
  (actual: unknown): any;
  objectContaining(value: Record<string, unknown>): any;
}

declare const describe: (name: string, suite: () => void) => void;
declare const it: (name: string, test: () => void) => void;
declare const expect: DomainTestExpect;
