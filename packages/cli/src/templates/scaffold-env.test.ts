// The scaffold ships two files built from one declaration. If they can disagree, `x new` produces
// an app whose very first `x verify` fails on X_ENV_EXAMPLE_DRIFT — so the agreement is asserted
// here, at the template, rather than discovered by whoever runs the scaffold next.

import { describe, expect, test } from 'bun:test';
import { checkEnvExample } from '@ultimat3/core';
import {
  envExampleSource,
  envSchemaSource,
  SCAFFOLD_ENV_SCHEMA,
  scaffoldEnvVarNames,
} from './scaffold-env';

describe('unit · the scaffold env declaration', () => {
  test('every declared variable reaches the committed example', () => {
    expect(checkEnvExample(SCAFFOLD_ENV_SCHEMA, envExampleSource())).toEqual({
      ok: true,
      missing: [],
      extra: [],
    });
  });

  test('the emitted TypeScript names exactly the variables the schema declares', () => {
    const source = envSchemaSource();
    for (const key of scaffoldEnvVarNames()) expect(source).toContain(`  ${key}: {`);
    expect(source.startsWith('export const envSchema = {')).toBe(true);
    expect(source.endsWith('} satisfies EnvSchema;')).toBe(true);
  });

  // Biome formats a generated app at 100 columns and keeps an object expanded when its source has
  // a newline after `{`. A reflowed line is a fresh app failing its own `lint` step on file one.
  test('no emitted line would be reformatted: under 100 columns, one property per line', () => {
    for (const line of envSchemaSource().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(
      envSchemaSource()
        .split('\n')
        .filter((line) => line.trim() === '}'),
    ).toEqual([]);
  });

  test('a secret is declared in the schema and carries no value into the example', () => {
    expect(envSchemaSource()).toContain('secret: true');
    expect(envExampleSource()).toContain('SESSION_SECRET=\n');
  });

  test('an empty declaration emits what Biome would emit, not what it would rewrite', () => {
    expect(envSchemaSource({})).toBe('export const envSchema = {} satisfies EnvSchema;');
  });
});
