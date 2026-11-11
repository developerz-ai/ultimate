// `x dev` after a broken save is fixed: a new page saved with a syntax error is a load finding, and
// the save that fixes it logged "reloaded" while the route answered 404 until a manual restart —
// the route table is mounted once, at boot. A generation this process cannot mount is a restart.
// The boot is the real one (`startDev`), the save a file on disk, the watcher's tick the trigger.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no recursive remove nor a bare mkdir, only a per-file write and delete.
import { mkdir, rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join, relative } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import type { StalePin } from './app-reload-graph';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { DEV_FIXTURE_FILES, resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.dev-recovery-fixture'));
const PAGE = 'apps/web/app/fresh/page.tsx';
/** The fixture's own page, under a new path: a route the boot never mounted. */
const GOOD = DEV_FIXTURE_FILES['apps/web/app/hello/page.tsx'] ?? '';
/** Generous and explicit, for the reason `cmd-dev.test.ts` gives: a hang reports as a hang. */
const BOOT_TIMEOUT_MS = 60_000;

let server: DevServer;
type Outcome =
  | { readonly kind: 'reload'; readonly file: string }
  | { readonly kind: 'restart'; readonly pins: readonly StalePin[]; readonly line: string };
let settle: (outcome: Outcome) => void = () => undefined;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(DEV_FIXTURE_FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  // The page's directory exists at boot, so the watcher's first tick names the page, not a new dir.
  await mkdir(join(ROOT, PAGE, '..'), { recursive: true });
  resetRegistries();
  server = await startDev({
    root: ROOT,
    port: 0,
    env: {},
    roles: ['web'],
    onReload: (file) => settle({ kind: 'reload', file }),
    onRestart: (pins, line) => settle({ kind: 'restart', pins, line }),
  });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetRegistries();
    resetLifecycle();
  }
}, BOOT_TIMEOUT_MS);

/** Writes the page and resolves with what the watcher's rebuild made of it. */
const save = async (contents: string): Promise<Outcome> => {
  const landed = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  await Bun.write(join(ROOT, PAGE), contents);
  return landed;
};

describe('unit · x dev after a load failure', () => {
  test(
    'a new page that will not import is a restart, so the ready line a new child prints is red',
    async () => {
      const outcome = await save(GOOD.replace('generation one', 'generation two').replace(')', ''));
      expect(outcome.kind).toBe('restart');
      // The log says why — a module fails to load — never "a module that defines a primitive".
      expect(outcome.kind === 'restart' ? outcome.line : '').toBe(
        `restarting: ${PAGE} changed which modules load (${PAGE} fails to load) — the new process prints the verdict`,
      );
      expect(server.findings.map((finding) => finding.at)).toContain(PAGE);
      // Supervised, the restart IS the answer: `/_x` carries no X_DEV_RESTART_REQUIRED beside it.
      expect(server.findings.map((finding) => finding.code)).not.toContain(
        'X_DEV_RESTART_REQUIRED',
      );
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'the save that fixes it is a restart too — the route it adds was never mounted — naming the page',
    async () => {
      const outcome = await save(GOOD.replace('generation one', 'generation three'));
      expect(outcome.kind).toBe('restart');
      const pins = outcome.kind === 'restart' ? outcome.pins : [];
      expect(pins.map((pin) => relative(ROOT, pin.pinned))).toEqual([PAGE]);
      expect(pins.map((pin) => relative(ROOT, pin.changed))).toEqual([PAGE]);
      expect(outcome.kind === 'restart' ? outcome.line : '').toBe(
        `restarting: ${PAGE} changed what x dev mounts (route /fresh (ssr, app) added) — the route table is built once, at boot`,
      );
    },
    BOOT_TIMEOUT_MS,
  );
});
