import { describe, expect, test } from 'bun:test';
import { ENV_EXAMPLE_PATH } from '@ultimat3/core';
import { doctorCommand, doctorPort, ENV_DEVELOPMENT, runDoctor } from './cmd-doctor';
import { codes, probe } from './cmd-doctor-fixture';
import { PORT_RANGE, parseIntFlag } from './flag-number';
import { frameworkSecretFindings } from './framework-env';
import { ICON_SOURCE } from './icon-assets';
import type { ParsedArgs } from './parse';
import { parseArgs } from './parse';

describe('unit · x doctor', () => {
  test('a retired key beside a sealed column is reported, and a clean ring is not', async () => {
    const columns = [{ entity: 'connections', column: 'password', lookup: false }];
    const current = 'a'.repeat(16);
    expect(
      await codes(probe({ sealedKeys: async () => ({ columns, keys: { current, retired: [] } }) })),
    ).toEqual([]);
    expect(
      await codes(
        probe({
          sealedKeys: async () => ({ columns, keys: { current, retired: ['b'.repeat(16)] } }),
        }),
      ),
    ).toEqual(['X_SEAL_RESEAL_PENDING']);
    expect(await codes(probe({ sealedKeys: async () => ({ columns, keys: undefined }) }))).toEqual([
      'X_SEAL_KEY_MISSING',
    ]);
  });

  test('a healthy environment reports nothing', async () => {
    expect(await codes(probe())).toEqual([]);
  });

  // The rule and its reasons are `doctor-offline.test.ts`; what belongs here is that `runDoctor`
  // ASKS. It used to decide for itself, off `probe.exists('apps/web/app/offline.tsx')` — a path
  // that is not a route file, is not what `x new` writes, and is not what the fix line creates.
  test('the offline fallback is asked of the route table, not of a filename', async () => {
    const findings = await runDoctor(
      probe({
        // Every file present, which is what made the old check pass: the finding now depends on
        // the app's own declaration and route table alone.
        exists: () => true,
        offlineFallback: async () => ({ fallback: '/offline', routes: [] }),
      }),
    );
    const fallback = findings.find((finding) => finding.code === 'X_PWA_NO_OFFLINE_FALLBACK');
    expect(fallback?.cause).toContain('/offline');
    expect(fallback?.fix).toBe('x g route offline --surface site');
  });

  test('an app whose route table serves the fallback reports nothing', async () => {
    expect(
      await codes(
        probe({
          offlineFallback: async () => ({
            fallback: '/offline',
            routes: [{ path: '/offline', surface: 'site' }],
          }),
        }),
      ),
    ).toEqual([]);
  });

  // `x new --force` was this fix for as long as the check has existed, and it can never run where
  // the reader is standing: reproduced, `x new --force --json` inside an app answers
  // `X_CLI_BAD_FLAG` — `x new` needs a <name> positional — and with a name it scaffolds a SECOND
  // app beside the broken one. The repair is a file, so the fix names the file, exactly as
  // `X_PWA_ICON_MISSING`'s does.
  test('a missing .env.development names the file write, never `x new`', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== ENV_DEVELOPMENT }));
    const env = findings.find((finding) => finding.code === 'X_ENV_MISSING');
    expect(env?.fix).toBe(`cp ${ENV_EXAMPLE_PATH} ${ENV_DEVELOPMENT}`);
    expect(env?.fix).not.toContain('x new');
    expect(env?.at).toBe(ENV_DEVELOPMENT);
  });

  test('a missing source icon is reported separately from the fallback', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== ICON_SOURCE }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_PWA_ICON_MISSING']);
    // An edit naming the file, pinned verbatim. `x new` was here and could never run: it takes an
    // app name, so it is not an instruction anyone inside the broken app can follow.
    expect(findings[0]?.fix).toBe(`add a 1024x1024 square PNG at ${ICON_SOURCE}`);
    expect(findings[0]?.fix).not.toContain('x new');
  });

  // The suggestion moves BOTH, which the docblock claimed and the code did not do: `x dev --port
  // N` occupies N and N + 1, so `3001` — the taken sync port — was handed back as the repair for
  // the very pair that failed.
  test('an occupied port suggests a pair clear of both ports x dev binds', async () => {
    const findings = await runDoctor(probe({ portFree: async () => false }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_PORT_IN_USE', 'X_PORT_IN_USE']);
    expect(findings[0]?.cause).toContain('port 3000');
    expect(findings[1]?.cause).toContain('port 3001');
    for (const finding of findings) {
      expect(finding.fix).toBe('x dev --port 3002');
    }
  });

  // The bug this guards: `port + 1` at the top of the range emitted `x dev --port 65536`, which
  // `x dev` refuses with X_CLI_BAD_FLAG — a fix line that reproduces a failure instead of ending
  // one. The neighbour below is a port; the one above does not exist.
  test('the suggested port is one x dev accepts, at the top of the range too', async () => {
    // The top of the range answers DOWNWARD: two above 65533 is 65535, whose own sync port does
    // not exist, so the suggestion would be a second refusal.
    const top = await runDoctor(probe({ port: PORT_RANGE.max - 2, portFree: async () => false }));
    expect(top[0]?.fix).toBe(`x dev --port ${PORT_RANGE.max - 4}`);
    // And the suggestion is still parseable by the reader it is handed to.
    for (const port of [3000, PORT_RANGE.max - 2]) {
      const findings = await runDoctor(probe({ port, portFree: async () => false }));
      const suggested = Number((findings[0]?.fix ?? '').split(' ').at(-1));
      // `x dev`'s own flag config, so the assertion is that the READER of this line accepts it.
      expect(
        parseIntFlag(String(suggested), {
          name: 'port',
          command: 'dev',
          ...PORT_RANGE,
          example: 'x dev --port 3000',
        }),
      ).toBe(suggested);
    }
  });

  // `neighbouringPort` answered 65534 for a `--port 65535` probe — a port BELOW the web port,
  // reported as the sync port `x dev` would bind. `x dev --port 65535` does not bind 65534: it
  // refuses, because `syncPortFor` has nowhere to put the sync node. The probe now says the same
  // thing the boot does, with the boot's own code.
  test('a web port with no room for the sync node is X_PORT_INVALID, not a probe of 65534', async () => {
    const probed: number[] = [];
    const findings = await runDoctor(
      probe({
        port: PORT_RANGE.max,
        portFree: async (port) => {
          probed.push(port);
          return true;
        },
      }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_PORT_INVALID']);
    expect(findings[0]?.fix).toContain('x dev --port');
    // The port below the web port is not the sync port, so it is never probed as one.
    expect(probed).not.toContain(PORT_RANGE.max - 1);
  });

  // `Bun.serve({ port: 0 })` always succeeds, so `x doctor --port 0` ran a check that could not
  // fail. 0 means "let the kernel pick" to `x dev` and means nothing at all to a probe.
  test('--port 0 is refused: a port to TEST is never the kernel picking one', () => {
    const args = (value: string): ParsedArgs =>
      parseArgs(['doctor', '--port', value], [doctorCommand.spec]);
    let caught: unknown;
    try {
      doctorPort(args('0'), {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(doctorPort(args('1'), {})).toBe(1);
    expect(doctorPort(args(String(PORT_RANGE.max)), {})).toBe(PORT_RANGE.max);
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

  // `X_CLI_UNEXPECTED`'s own `fix:` is `x doctor --json`, and the throw an author most often hits
  // on a first run is `x db gen` refusing a migration with no snapshot — a condition this probe
  // could not see, so the fix ran clean and reported nothing about the thing that was broken.
  test('a migration with no snapshot sidecar is reported, so the X_CLI_UNEXPECTED fix answers', async () => {
    const findings = await runDoctor(
      probe({
        snapshots: async () => [
          {
            code: 'X_MIGRATION_SNAPSHOT_MISSING',
            cause: 'migration "0001_init" records no schema snapshot',
            fix: 'git checkout -- packages/db/migrations/0001_init.snapshot.json',
          },
        ],
      }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_MIGRATION_SNAPSHOT_MISSING']);
  });

  // The probe carries what the boot would refuse (`framework-env.ts` decides, `probeFor` asks);
  // `runDoctor` reports it verbatim — one list, so a third secret cannot be mis-wired here.
  test('the framework-secret findings the probe carries are reported, wording and all', async () => {
    const findings = await runDoctor(probe({ frameworkFindings: frameworkSecretFindings({}) }));
    const cursor = findings.find((finding) => finding.code === 'X_CURSOR_SECRET_DEV');
    expect(cursor?.cause).toContain('forge a page position');
    // Pinned verbatim: this string is copied into a shell, so a paraphrase of it is a broken fix.
    expect(cursor?.fix).toBe('export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"');
    const storage = findings.find((finding) => finding.code === 'X_STORAGE_SECRET_DEV');
    expect(storage?.cause).toContain('uploadPolicy');
    expect(storage?.fix).toBe('export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"');
  });

  test('a probe owing nothing reports nothing', async () => {
    expect(await codes(probe({ frameworkFindings: [] }))).toEqual([]);
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
