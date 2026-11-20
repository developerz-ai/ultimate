// The 31.16.0 doctor checks warn on `main`: an app that upgrades with no change keeps a green
// `x doctor`, and each check is still reported — code, cause and fix — in `data.warnings`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { reportDoctor, runDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import { browserProbe } from './doctor-browser';
import { renderJson } from './output';
import { scaffoldGuardFiles } from './templates';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * An app root holding every shipped guard, as `x new` writes it: a missing one is its own warning
 * (`doctor-guards.test.ts`), and these cases are about the others.
 */
const appRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'x-doctor-warn-'));
  roots.push(root);
  mkdirSync(join(root, 'guards'));
  for (const file of scaffoldGuardFiles()) writeFileSync(join(root, file.path), file.contents);
  return root;
};

/** An app pinning `@ultimat3/core` as a range — the adopter shape `x new` never writes. */
const ranged = () => {
  const root = appRoot();
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

  // The machine's Chrome was asked from inside `reportDoctor`, so the first test of a file paid a
  // cold `chrome --version` on its clock: CI unit-3 timed this file out at 5 s and Bun "killed 1
  // dangling process" (run 43802046886). The browser is the probe's answer, like every other fact.
  test("the browser reported is the probe's answer, never this machine's Chrome", async () => {
    const root = appRoot();
    const fact = await browserProbe(root, { CHROME_PATH: '/nonexistent/fake-chrome' }, 'linux');
    const answered = fact === undefined ? undefined : { ...fact, path: '/opt/fake/chrome' };
    const result = await reportDoctor(probe({ root, browser: async () => answered }));
    expect(result.data).toMatchObject({ browser: { path: '/opt/fake/chrome' } });
  });

  test('a clean app carries no warnings key at all', async () => {
    const result = await reportDoctor(probe({ root: appRoot() }));
    expect(result.data).not.toHaveProperty('warnings');
  });

  test('outside an app nothing is warned: the one finding is X_NOT_IN_APP', async () => {
    const result = await reportDoctor(probe({ root: undefined }));
    expect((result.findings ?? []).map((finding) => finding.code)).toEqual(['X_NOT_IN_APP']);
    expect(result.data).not.toHaveProperty('warnings');
  });

  // A neighbour's dev server is a warning (`doctor-port.ts`); it was computed and never reported,
  // so another checkout's port vanished from `x doctor` instead of moving beside the verdict.
  test("another checkout's port is a warning beside a green verdict", async () => {
    const root = appRoot();
    const result = await reportDoctor(
      probe({
        root,
        portFree: async (port) => port !== 3000,
        portOwner: async () => ({ pid: 41, cwd: `${root}-other` }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ warnings: [{ code: 'X_PORT_IN_USE' }] });
  });

  // The verdict and the warnings each asked the OS who held the port. On a loaded CI runner the
  // first `ss` named nobody (a finding) and the second named another checkout (a warning): one
  // taken port, reported twice. One report per run, so the two halves read the same answer.
  test('a taken port is looked up once, so it is a finding or a warning, never both', async () => {
    const root = appRoot();
    let asked = 0;
    const result = await reportDoctor(
      probe({
        root,
        portFree: async (port) => port !== 3000,
        portOwner: async () => (++asked === 1 ? {} : { pid: 41, cwd: `${root}-other` }),
      }),
    );
    const warned = ((result.data as { warnings?: readonly { code: string }[] }).warnings ?? [])
      .length;
    const failed = (result.findings ?? []).filter((one) => one.code === 'X_PORT_IN_USE').length;
    expect({ asked, reported: warned + failed }).toEqual({ asked: 1, reported: 1 });
  });

  // Served by the scan, so never refused: an app that upgrades keeps a green doctor, and is told
  // the import line that lists the action — the one X_JOB_UNREGISTERED prints for a job.
  test('an action no defineApi() lists is a warning, never a finding', async () => {
    const unlisted = {
      code: 'X_ACTION_UNREGISTERED',
      cause: 'refundTicket declared in apps/web/app/ticket/actions/refund-ticket.ts is an action',
      fix: "import * as refundTicket from '../app/ticket/actions/refund-ticket';",
      at: 'apps/web/app/ticket/actions/refund-ticket.ts',
    };
    const result = await reportDoctor(
      probe({ root: appRoot(), unlistedPrimitives: async () => [unlisted] }),
    );
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.data).toMatchObject({ warnings: [{ code: 'X_ACTION_UNREGISTERED' }] });
  });

  // The release the codemods owed are measured up to is the probe's, never the stamp: read from
  // `package.json`, the 31.49.0 bump made this file's bare app root owe `merge-drivers` (it writes
  // a `.gitattributes`) and redded only the release PR (#1284).
  test("codemods owed are measured up to the probe's release, so a bump moves no report", async () => {
    const root = appRoot();
    const before = await reportDoctor(probe({ root, release: '31.48.0' }));
    expect(before.data).not.toHaveProperty('warnings');
    const after = await reportDoctor(probe({ root, release: '31.49.0' }));
    expect(after.data).toMatchObject({
      warnings: [{ code: 'X_UPGRADE_CODEMODS_PENDING', at: '.gitattributes' }],
    });
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
