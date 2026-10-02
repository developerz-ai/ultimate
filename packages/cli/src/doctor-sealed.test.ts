// `x doctor`'s sealed-column rules, as pure functions of the fact the probe gathers. The probe —
// loading the app and resolving the key ring — is `sealedKeysProbe`; what a fact MEANS is here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway roots.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  generateMasterKey,
  masterKeyId,
  masterKeyPath,
  parseMasterKey,
  SECRETS_KEY_ENV,
  SECRETS_RETIRED_KEYS_ENV,
  writeMasterKeyFile,
  writeSecretsFile,
} from '@ultimat3/core';
import { clearRegistry } from '@ultimat3/entity';
import type { SealedKeysFact } from './doctor-sealed';
import { sealedKeyFindings, sealedKeysProbe } from './doctor-sealed';

const columns = [
  { entity: 'connections', column: 'password', lookup: false },
  { entity: 'connections', column: 'email', lookup: true },
];
const fact = (over: Partial<SealedKeysFact> = {}): SealedKeysFact => ({
  columns,
  keys: { current: 'aaaaaaaaaaaaaaaa', retired: [] },
  ...over,
});

describe('unit · x doctor on sealed columns', () => {
  test('sealed columns under one key are clean', () => {
    expect(sealedKeyFindings(fact())).toEqual([]);
  });

  test('an app with no sealed column is never judged, key or no key', () => {
    expect(sealedKeyFindings(fact({ columns: [], keys: undefined }))).toEqual([]);
    expect(
      sealedKeyFindings(
        fact({ columns: [], keys: { current: 'a'.repeat(16), retired: ['b'.repeat(16)] } }),
      ),
    ).toEqual([]);
  });

  test('an app that would not load is not judged — a short registry is not "no sealed columns"', () => {
    expect(sealedKeyFindings(fact({ columns: undefined, keys: undefined }))).toEqual([]);
  });

  test('sealed columns and no master key is X_SEAL_KEY_MISSING, before the first write finds out', () => {
    const [finding, ...rest] = sealedKeyFindings(fact({ keys: undefined }));
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_SEAL_KEY_MISSING');
    expect(finding?.cause).toContain('connections.password, connections.email');
    expect(finding?.fix).toStartWith('x secrets init');
  });

  test('a retired key still declared is re-seal pending, naming the columns and the drop', () => {
    const retired = ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    const [finding, ...rest] = sealedKeyFindings(
      fact({ keys: { current: 'aaaaaaaaaaaaaaaa', retired } }),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_SEAL_RESEAL_PENDING');
    expect(finding?.cause).toContain('connections.password, connections.email');
    expect(finding?.cause).toContain('bbbbbbbbbbbbbbbb, cccccccccccccccc');
    // The lookup column is what the window actually weakens, and it is named for that.
    expect(finding?.cause).toContain('connections.email is a lookup column');
    expect(finding?.fix).toContain('x secrets rotate --drop bbbbbbbbbbbbbbbb');
    expect(finding?.fix).toContain('backfill()');
  });

  test('with no lookup column the finding still stands: the retired key cannot be dropped yet', () => {
    const [finding] = sealedKeyFindings(
      fact({
        columns: [columns[0] ?? expect.unreachable('fixture')],
        keys: { current: 'a'.repeat(16), retired: ['b'.repeat(16)] },
      }),
    );
    expect(finding?.code).toBe('X_SEAL_RESEAL_PENDING');
    expect(finding?.cause).not.toContain('lookup column');
  });
});

describe('unit · the sealed-keys probe', () => {
  let base = '';
  let counter = 0;
  const idOf = (hex: string): Promise<string> => masterKeyId(parseMasterKey(hex, 'test'));
  const declared = async () => columns;
  const root = async (): Promise<string> => {
    counter += 1;
    const dir = join(base, `app-${counter}`);
    await Bun.write(join(dir, '.keep'), '');
    return dir;
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'x-doctor-sealed-'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('an app that would not load, or declares none, never opens the secrets', async () => {
    const dir = await root();
    expect(await sealedKeysProbe(dir, {}, async () => undefined)).toEqual({
      columns: undefined,
      keys: undefined,
    });
    expect(await sealedKeysProbe(dir, {}, async () => [])).toEqual({
      columns: [],
      keys: undefined,
    });
  });

  test('no key anywhere is `keys: undefined`, which the rule reads as X_SEAL_KEY_MISSING', async () => {
    const fact = await sealedKeysProbe(await root(), {}, declared);
    expect(fact).toEqual({ columns, keys: undefined });
    expect(sealedKeyFindings(fact).map((one) => one.code)).toEqual(['X_SEAL_KEY_MISSING']);
  });

  test('the ring is read from the committed file — what a booted process would see', async () => {
    const dir = await root();
    const [current, retired] = [generateMasterKey(), generateMasterKey()];
    writeMasterKeyFile(dir, current);
    const key = { hex: current, source: 'file' as const, at: masterKeyPath(dir) };
    await writeSecretsFile(dir, { [SECRETS_RETIRED_KEYS_ENV]: retired }, key);
    const fact = await sealedKeysProbe(dir, {}, declared);
    expect(fact.keys).toEqual({ current: await idOf(current), retired: [await idOf(retired)] });
    expect(sealedKeyFindings(fact).map((one) => one.code)).toEqual(['X_SEAL_RESEAL_PENDING']);
  });

  test('the real environment wins over the file, and a key with no ring is clean', async () => {
    const dir = await root();
    const [current, retired] = [generateMasterKey(), generateMasterKey()];
    const env = { [SECRETS_KEY_ENV]: current, [SECRETS_RETIRED_KEYS_ENV]: retired };
    const fact = await sealedKeysProbe(dir, env, declared);
    expect(fact.keys?.retired).toEqual([await idOf(retired)]);
    const clean = await sealedKeysProbe(dir, { [SECRETS_KEY_ENV]: current }, declared);
    expect(clean.keys).toEqual({ current: await idOf(current), retired: [] });
    expect(sealedKeyFindings(clean)).toEqual([]);
  });

  test('a malformed key is no usable key, never a crash in a diagnostic', async () => {
    const fact = await sealedKeysProbe(await root(), { [SECRETS_KEY_ENV]: 'abc' }, declared);
    expect(fact.keys).toBeUndefined();
  });
});

const ENTITY_SOURCE = join(import.meta.dir, '..', '..', 'entity', 'src', 'index.ts');

describe('unit · the sealed-keys probe reads the app it is pointed at', () => {
  let base = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'x-doctor-sealed-app-'));
  });
  afterAll(async () => {
    clearRegistry();
    await rm(base, { recursive: true, force: true });
  });

  test('a real app: its sealed columns are found by entity and property, lookup marked', async () => {
    const dir = join(base, 'loads');
    await Bun.write(
      join(dir, 'packages/db/src/schema.ts'),
      [
        // By path: a module under /tmp cannot resolve a workspace specifier, and this is the same
        // file `@ultimat3/entity` resolves to here — one registry, the one the probe reads.
        `import { entity, text, uuid } from ${JSON.stringify(ENTITY_SOURCE)};`,
        "export const vaults = entity('doctor_sealed_vaults', {",
        '  columns: {',
        '    id: uuid().primaryKey(),',
        '    label: text(),',
        '    apiKey: text().sealed(),',
        '    contact: text().sealed({ lookup: true }),',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const key = generateMasterKey();
    const fact = await sealedKeysProbe(dir, { [SECRETS_KEY_ENV]: key });
    // Scoped to this fixture's entity: the registry is process-wide, and another file's entities
    // are not this app's.
    expect(fact.columns?.filter((one) => one.entity === 'doctor_sealed_vaults')).toEqual([
      { entity: 'doctor_sealed_vaults', column: 'apiKey', lookup: false },
      { entity: 'doctor_sealed_vaults', column: 'contact', lookup: true },
    ]);
    expect(fact.keys?.retired).toEqual([]);
  });

  test('an app with a module that will not import is not judged', async () => {
    const dir = join(base, 'broken');
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const broken = ;\n');
    expect(await sealedKeysProbe(dir, {})).toEqual({ columns: undefined, keys: undefined });
  });
});
