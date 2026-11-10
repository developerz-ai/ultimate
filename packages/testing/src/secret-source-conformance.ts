// The `secretSource` port's contract as shared examples: `behavesLike(secretSourceConformance, ()
// => subject)`. A source cannot be handed a key through the port, so the subject arranges one — the
// env var, a key file, a KMS fake's own table — and the suite asks for it back through `masterKey`
// only.

import { expect, test } from 'bun:test';
import type { SecretSource, SecretSourceContext } from '@ultimat3/core/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** A source plus the two worlds it is asked in: one holding `hex`, one holding nothing. */
export interface SecretSourceSubject {
  readonly source: SecretSource;
  /** A context this source answers `hex` for. A fresh one per call — two calls, two places. */
  holding(hex: string): Maybe<SecretSourceContext>;
  /** A context this source has no key for. */
  empty(): Maybe<SecretSourceContext>;
}

export interface SecretSourceCheck {
  readonly name: string;
  run(subject: SecretSourceSubject): Promise<void>;
}

let minted = 0;
/** 64 hex chars, distinct per call: the AES-256 key shape `x secrets init` writes. */
const keyHex = (): string => {
  minted += 1;
  return `${process.pid.toString(16)}${minted.toString(16)}`.padStart(64, 'a');
};

/** The answer, or the failure itself — "absent" must never be a throw or a rejection. */
const asked = async (source: SecretSource, context: SecretSourceContext): Promise<unknown> => {
  try {
    return await source.masterKey(context);
  } catch (error) {
    return { threw: error };
  }
};

export const SECRET_SOURCE_CHECKS: readonly SecretSourceCheck[] = [
  {
    name: 'a place holding no key answers undefined — never a throw, never a rejection',
    async run({ source, empty }) {
      expect(await asked(source, await empty())).toBeUndefined();
    },
  },
  {
    name: 'a place holding a key answers exactly that key, twice in a row',
    async run({ source, holding }) {
      const hex = keyHex();
      const context = await holding(hex);
      expect((await source.masterKey(context))?.hex).toBe(hex);
      expect((await source.masterKey(context))?.hex).toBe(hex);
    },
  },
  {
    name: 'the answer names its source and where it was read — and the place never carries the key',
    async run({ source, holding }) {
      const hex = keyHex();
      const ref = await source.masterKey(await holding(hex));
      expect(source.name.length).toBeGreaterThan(0);
      expect(ref?.source.length ?? 0).toBeGreaterThan(0);
      expect(ref?.at.length ?? 0).toBeGreaterThan(0);
      expect(ref?.at).not.toContain(hex);
      expect(ref?.source).not.toContain(hex);
    },
  },
  {
    name: 'two places holding two keys answer each its own — nothing is kept across contexts',
    async run({ source, holding }) {
      const [first, second] = [keyHex(), keyHex()];
      const [one, two] = [await holding(first), await holding(second)];
      expect((await source.masterKey(one))?.hex).toBe(first);
      expect((await source.masterKey(two))?.hex).toBe(second);
    },
  },
];

export const secretSourceConformance: SharedExamples<SecretSourceSubject> = sharedExamples(
  'a secret source',
  (subject) => {
    for (const check of SECRET_SOURCE_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
