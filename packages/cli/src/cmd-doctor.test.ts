import { describe, expect, test } from 'bun:test';
import type { DoctorProbe } from './cmd-doctor';
import { ICON_SOURCE, OFFLINE_FALLBACK, runDoctor } from './cmd-doctor';

const probe = (over: Partial<DoctorProbe> = {}): DoctorProbe => ({
  bunVersion: '1.3.14',
  root: '/app',
  port: 3000,
  exists: () => true,
  portFree: async () => true,
  drift: async () => [],
  ...over,
});

const codes = async (input: DoctorProbe): Promise<readonly string[]> =>
  (await runDoctor(input)).map((finding) => finding.code);

describe('unit · x doctor', () => {
  test('a healthy environment reports nothing', async () => {
    expect(await codes(probe())).toEqual([]);
  });

  test('a missing offline fallback is reported with the generator that creates it', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== OFFLINE_FALLBACK }));
    const fallback = findings.find((finding) => finding.code === 'X_PWA_NO_FALLBACK');
    expect(fallback?.cause).toContain(OFFLINE_FALLBACK);
    expect(fallback?.fix).toBe('x g route offline --surface app');
    expect(fallback?.at).toBe(OFFLINE_FALLBACK);
  });

  test('a missing source icon is reported separately from the fallback', async () => {
    expect(await codes(probe({ exists: (path) => path !== ICON_SOURCE }))).toEqual([
      'X_PWA_NO_ICON_SOURCE',
    ]);
  });

  test('an occupied port suggests the next one', async () => {
    const findings = await runDoctor(probe({ portFree: async () => false }));
    expect(findings[0]?.code).toBe('X_PORT_IN_USE');
    expect(findings[0]?.fix).toBe('x dev --port 3001');
  });

  test('running outside an app stops after the one finding that explains everything', async () => {
    const findings = await runDoctor(probe({ root: undefined, exists: () => false }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_NOT_IN_APP']);
    expect(findings[0]?.fix).toBe('x new myapp');
  });

  test('an old Bun is reported first, because it explains the rest', async () => {
    const findings = await runDoctor(probe({ bunVersion: '1.2.0' }));
    expect(findings[0]?.code).toBe('X_BUN_VERSION');
    expect(findings[0]?.fix).toBe('bun upgrade');
  });

  test('drift findings are appended with their own fix command', async () => {
    const findings = await runDoctor(
      probe({
        drift: async () => [
          { code: 'X_DB_DRIFT', cause: 'schema differs', fix: 'x db gen "add publish_at"' },
        ],
      }),
    );
    expect(findings.at(-1)?.fix).toBe('x db gen "add publish_at"');
  });

  test('every finding carries a fix command — a diagnostic without one is not shippable', async () => {
    const findings = await runDoctor(probe({ exists: () => false, portFree: async () => false }));
    expect(findings.length).toBeGreaterThan(2);
    for (const finding of findings) expect(finding.fix.length).toBeGreaterThan(0);
  });
});
