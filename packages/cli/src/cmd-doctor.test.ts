import { afterEach, describe, expect, test } from 'bun:test';
import type { DoctorProbe } from './cmd-doctor';
import { OFFLINE_FALLBACK, probeFor, runDoctor } from './cmd-doctor';
import { ICON_SOURCE } from './dev-assets';

const probe = (over: Partial<DoctorProbe> = {}): DoctorProbe => ({
  bunVersion: '1.3.14',
  root: '/app',
  port: 3000,
  // The ordinary developer: the shipped cursor key, off production. Every case below that does
  // not say otherwise is this one.
  devCursorSecret: true,
  devStorageSecret: true,
  production: false,
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
    const fallback = findings.find((finding) => finding.code === 'X_PWA_NO_OFFLINE_FALLBACK');
    expect(fallback?.cause).toContain(OFFLINE_FALLBACK);
    expect(fallback?.fix).toBe('x g route offline --surface app');
    expect(fallback?.at).toBe(OFFLINE_FALLBACK);
  });

  test('a missing source icon is reported separately from the fallback', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== ICON_SOURCE }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_PWA_ICON_MISSING']);
    // An edit naming the file, pinned verbatim. `x new` was here and could never run: it takes an
    // app name, so it is not an instruction anyone inside the broken app can follow.
    expect(findings[0]?.fix).toBe(`add a 1024x1024 square PNG at ${ICON_SOURCE}`);
    expect(findings[0]?.fix).not.toContain('x new');
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

  // A finding every developer sees on day one is one they learn to skip, and the report goes with
  // it — so the noise case is what makes the production gate real, not the finding itself.
  test('the shipped cursor key is silent in development, where it is the design', async () => {
    expect(await codes(probe({ devCursorSecret: true }))).toEqual([]);
  });

  test('the shipped cursor key in production is reported with the command that mints one', async () => {
    const findings = await runDoctor(probe({ devCursorSecret: true, production: true }));
    const cursor = findings.find((finding) => finding.code === 'X_CURSOR_SECRET_DEV');
    expect(cursor?.cause).toContain('forge a page position');
    // Pinned verbatim: this string is copied into a shell, so a paraphrase of it is a broken fix.
    expect(cursor?.fix).toBe('export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"');
  });

  test('a production deploy with its own secrets reports nothing', async () => {
    expect(
      await codes(probe({ devCursorSecret: false, devStorageSecret: false, production: true })),
    ).toEqual([]);
  });

  // The storage twin, and the more expensive one: the published key mints a signed PUT for any
  // key with any maxBytes and contentType, and `acceptSignedUpload` trusts a signed constraint
  // over the app's own uploadPolicy.
  test('the shipped storage key is silent in development, where it is the design', async () => {
    expect(await codes(probe({ devStorageSecret: true }))).toEqual([]);
  });

  test('the shipped storage key in production is reported with the command that mints one', async () => {
    const findings = await runDoctor(
      probe({ devCursorSecret: false, devStorageSecret: true, production: true }),
    );
    const storage = findings.find((finding) => finding.code === 'X_STORAGE_SECRET_DEV');
    expect(storage?.cause).toContain('STORAGE_SIGNING_SECRET');
    expect(storage?.cause).toContain('uploadPolicy');
    // Pinned verbatim: this string is copied into a shell, so a paraphrase of it is a broken fix.
    expect(storage?.fix).toBe('export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"');
  });

  test('every finding carries a fix command — a diagnostic without one is not shippable', async () => {
    const findings = await runDoctor(probe({ exists: () => false, portFree: async () => false }));
    expect(findings.length).toBeGreaterThan(2);
    for (const finding of findings) expect(finding.fix.length).toBeGreaterThan(0);
  });
});

// Every case above hands `runDoctor` the `production` boolean, so the one place that derives it
// from the environment is the half nothing covered — and it decides whether BOTH secret findings
// fire at all. It read `X_ENV ?? NODE_ENV`, a spelling nothing else in the repo reads, so a deploy
// that declared production the framework's own documented way (`ULTIMATE_ENV=production`) was told
// it was not production and skipped the two checks standing between it and a published signing
// key. All three variables are restored after each case: bun shares one process across test files,
// and a leaked environment would decide a later file's answer by load order.
describe('unit · x doctor · probeFor', () => {
  type EnvKey = 'ULTIMATE_ENV' | 'X_ENV' | 'NODE_ENV';
  const KEYS: readonly EnvKey[] = ['ULTIMATE_ENV', 'X_ENV', 'NODE_ENV'];
  const SAVED = new Map(KEYS.map((key) => [key, Bun.env[key]]));

  const setEnv = (key: EnvKey, value: string | undefined): void => {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  };

  afterEach(() => {
    for (const key of KEYS) setEnv(key, SAVED.get(key));
  });

  const production = (over: Partial<Record<EnvKey, string>>): boolean => {
    for (const key of KEYS) setEnv(key, over[key]);
    return probeFor(import.meta.dir, '1.3.14', 3000).production;
  };

  test('ULTIMATE_ENV=production is a production process', () => {
    expect(production({ ULTIMATE_ENV: 'production' })).toBe(true);
  });

  // Core's documented fallback, kept: every container image and platform sets it, and an app that
  // never heard of `ULTIMATE_ENV` must still be diagnosed correctly.
  test('NODE_ENV=production alone is a production process', () => {
    expect(production({ NODE_ENV: 'production' })).toBe(true);
  });

  // The precedence that matters: a base image that bakes in `NODE_ENV=production` would otherwise
  // make `x doctor` report a forgeable cursor at every `x dev` inside it, and the developer who
  // said so with the framework's own key would have been overruled by the image.
  test('ULTIMATE_ENV overrides NODE_ENV rather than falling back to it', () => {
    expect(production({ ULTIMATE_ENV: 'development', NODE_ENV: 'production' })).toBe(false);
  });

  // `X_ENV` is a spelling nothing in this repo reads. It must not decide, and — this is the half
  // that bit — it must not SHADOW: `X_ENV ?? NODE_ENV` short-circuited on any non-empty value, so
  // one stale variable turned a real production deploy into "not production".
  test('X_ENV decides nothing, and shadows nothing', () => {
    expect(production({ X_ENV: 'production' })).toBe(false);
    expect(production({ X_ENV: 'prod', NODE_ENV: 'production' })).toBe(true);
  });

  // `ULTIMATE_ENV` is not in the env schema, so nothing validates it at boot and `x doctor` can be
  // its first reader. `tryResolveEnvironment` answers `undefined` rather than throwing — a typo
  // must be a diagnostic that runs, not a diagnostic that crashes.
  test('a misspelled ULTIMATE_ENV answers "not production" instead of throwing', () => {
    expect(production({ ULTIMATE_ENV: 'prodcution' })).toBe(false);
  });

  test('no variable set is not production', () => {
    expect(production({})).toBe(false);
  });
});
