// The last check before a cassette reaches disk: is any secret's value in the exact bytes about
// to be written, in any of the encodings a vendor echoes one back in? A hit names the KEY and the
// byte offset — never the value, which would put it in a terminal and a CI log instead.

import { isRedactedKey } from '@ultimat3/core';

/**
 * Shorter values are skipped, stated rather than hidden: a 4-character "secret" occurs by chance
 * in any base64 body, and a refusal that fires on noise is one somebody switches off.
 */
export const SECRET_MIN_LENGTH = 8;

export interface SecretSource {
  /** An env key, or `secrets[<i>]` for a value handed to the cassette. */
  readonly key: string;
  readonly value: string;
}

export interface SecretHit {
  readonly key: string;
  /** UTF-8 byte offset into the scanned text. */
  readonly offset: number;
  readonly encoding: 'raw' | 'json' | 'percent' | 'base64' | 'base64url';
}

/**
 * What to look for: every env value whose key `isRedactedKey` answers yes to (which includes every
 * key `defineEnv({ secret: true })` registered), plus the values the cassette was handed.
 */
export function secretSources(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
): readonly SecretSource[] {
  const sources: SecretSource[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= SECRET_MIN_LENGTH && isRedactedKey(key)) {
      sources.push({ key, value });
    }
  }
  extra.forEach((value, index) => {
    if (value.length >= SECRET_MIN_LENGTH) sources.push({ key: `secrets[${index}]`, value });
  });
  return sources;
}

/** The first secret found in `text`, by position; `undefined` when the bytes are clean. */
export function findSecret(text: string, sources: readonly SecretSource[]): SecretHit | undefined {
  let first: { hit: SecretHit; index: number } | undefined;
  for (const source of sources) {
    for (const [encoding, needle] of encodings(source.value)) {
      const index = text.indexOf(needle);
      if (index >= 0 && (first === undefined || index < first.index)) {
        first = { index, hit: { key: source.key, offset: byteOffset(text, index), encoding } };
      }
    }
  }
  return first?.hit;
}

function encodings(value: string): ReadonlyArray<readonly [SecretHit['encoding'], string]> {
  const bytes = Buffer.from(value, 'utf8');
  // Padding is dropped: a value base64-encoded inside a longer string carries none of its own.
  const base64 = bytes.toString('base64').replace(/=+$/, '');
  const base64url = bytes.toString('base64url');
  return [
    ['raw', value],
    // As a JSON string literal holds it: a quote or a backslash in the value is escaped there.
    ['json', JSON.stringify(value).slice(1, -1)],
    ['percent', encodeURIComponent(value)],
    ['base64', base64],
    ['base64url', base64url],
  ];
}

function byteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}
