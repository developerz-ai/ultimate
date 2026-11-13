// The 31.16.0 doctor checks warn on `main`: an app that upgrades with no change keeps a green
// `x doctor`, and each check is still reported — code, cause and fix — in `data.warnings`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { reportDoctor, runDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import { renderJson } from './output';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An app pinning `@ultimat3/core` as a range — the adopter shape `x new` never writes. */
const ranged = () => {
  const root = mkdtempSync(join(tmpdir(), 'x-doctor-warn-'));
  roots.push(root);
  return probe({
    root,
    pins: async () => ({
      pins: [{ file: 'package.json', name: '@ultimat3/core', spec: '^31.0.0' }],
      installed: new Map([['@ultimat3/core', '31.16.0']]),
    }),
  });
};

describe('unit · x doctor · warnings beside the verdict', () => {
  test('a ranged pin keeps the doctor green and is listed in data.warnings with its fix', async () => {
    const result = await reportDoctor(ranged());
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    const payload = JSON.parse(renderJson(result)) as {
      ok: boolean;
      data: { codes: string[]; warnings: { code: string; cause: string; fix: string }[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.codes).toEqual([]);
    expect(payload.data.warnings.map((warning) => warning.code)).toEqual(['X_FRAMEWORK_PIN_RANGE']);
    expect(payload.data.warnings[0]?.cause).toContain('@ultimat3/core ^31.0.0');
    expect(payload.data.warnings[0]?.fix).toContain('"@ultimat3/core": "31.16.0"');
    // A person reads the same warning on its own line.
    expect(result.lines?.some((line) => line.includes('X_FRAMEWORK_PIN_RANGE'))).toBe(true);
  });

  test('a clean app carries no warnings key at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-warn-'));
    roots.push(root);
    const result = await reportDoctor(probe({ root }));
    expect(result.data).not.toHaveProperty('warnings');
  });

  test('outside an app nothing is warned: the one finding is X_NOT_IN_APP', async () => {
    const result = await reportDoctor(probe({ root: undefined }));
    expect((result.findings ?? []).map((finding) => finding.code)).toEqual(['X_NOT_IN_APP']);
    expect(result.data).not.toHaveProperty('warnings');
  });

  test('a real finding still reds the doctor, with the warnings beside it', async () => {
    const result = await reportDoctor({ ...ranged(), exists: () => false });
    expect(result.ok).toBe(false);
    expect(await runDoctor({ ...ranged(), exists: () => false })).not.toContainEqual(
      expect.objectContaining({ code: 'X_FRAMEWORK_PIN_RANGE' }),
    );
    expect(result.data).toMatchObject({ warnings: [{ code: 'X_FRAMEWORK_PIN_RANGE' }] });
  });
});
