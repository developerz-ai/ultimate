// `x dev`'s save loop, end to end: a file is written under a running server, the watcher's rebuild
// lands, and the next request serves what is on disk. Its own file because every test here moves
// the reload counter `cmd-dev.test.ts` reads as zero, and because the boot is the fixture's real
// one — embedded Postgres, the watcher, the HTTP role — never a stubbed rescan.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isolateDeclaredTags } from '@ultimat3/cache';
import { resetLifecycle } from '@ultimat3/core';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { DEV_FIXTURE_FILES as FILES, resetRegistries } from './cmd-dev-fixture';
import { CliNotImplementedError } from './errors';

const ROOT = join(import.meta.dir, '..', '.dev-reload-fixture');
/** Generous and explicit, for the reason `cmd-dev.test.ts` gives: a hang reports as a hang. */
const BOOT_TIMEOUT_MS = 60_000;

let server: DevServer;
/** Rebound by each test that saves a file, so it can await the tick the watcher turned into. */
let onReload: (file: string) => void = () => undefined;
const restoreTags = isolateDeclaredTags();

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetRegistries();
  server = await startDev({
    root: ROOT,
    port: 0,
    env: { BUILD_ID: 'stamped-7' },
    roles: ['web'],
    onReload: (file) => onReload(file),
  });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetRegistries();
    restoreTags();
    resetLifecycle();
  }
}, BOOT_TIMEOUT_MS);

const page = async (path: string): Promise<string> => {
  const handle = server.running.server;
  if (handle === null) {
    throw new CliNotImplementedError({
      feature: 'fetching from x dev without the web role',
      fix: 'x dev --role web',
    });
  }
  return (await handle.fetch(new Request(`http://dev.test${path}`))).text();
};

/** Writes `file` with `from` replaced by `to`, and resolves once the watcher's rebuild landed. */
const save = async (file: string, from: string, to: string): Promise<string> => {
  const reloaded = new Promise<string>((resolve) => {
    onReload = resolve;
  });
  await Bun.write(join(ROOT, file), FILES[file]?.replace(from, to) ?? '');
  return reloaded;
};

describe('unit · x dev serves the save', () => {
  // The defect — `rebuild` re-ran `loadApp`, `import()` answered from its cache, `register` saw a
  // registered file, so the table kept the FIRST component while `buildIslands` re-bundled the
  // island: a new island, an old page.
  test(
    'an edited page.tsx is served fresh on the next request',
    async () => {
      const file = 'apps/web/app/hello/page.tsx';
      expect(await page('/hello')).toContain('generation one');
      expect(await save(file, 'generation one', 'generation two')).toBe(file);
      expect(await page('/hello')).toContain('generation two');
    },
    BOOT_TIMEOUT_MS,
  );

  // Two defects in one request (notificado.co, 2026-09-27): the page module's own bytes never
  // change, so re-importing only a CHANGED route module kept the cached component; and the ISR
  // store kept the first render for the life of the process.
  test(
    'an edited component is served fresh on an isr page that imports it',
    async () => {
      const file = 'apps/web/site/news/headline.tsx';
      expect(await page('/news')).toContain('headline one');
      expect(await save(file, 'headline one', 'headline two')).toBe(file);
      expect(await page('/news')).toContain('headline two');
    },
    BOOT_TIMEOUT_MS,
  );
});
