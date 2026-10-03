// `x dev`'s save loop, end to end: a file is written under a running server, the watcher's rebuild
// lands, and the next request serves what is on disk. Its own file because every test here moves
// the reload counter `cmd-dev.test.ts` reads as zero, and because the boot is the fixture's real
// one — embedded Postgres, the watcher, the HTTP role — never a stubbed rescan.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join, relative } from 'node:path';
import { invalidateTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { resetLifecycle } from '@ultimat3/core';
import type { StalePin } from './app-reload-graph';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { DEV_FIXTURE_FILES, resetRegistries } from './cmd-dev-fixture';
import { CliNotImplementedError } from './errors';

const ROOT = join(import.meta.dir, '..', '.dev-reload-fixture');

/**
 * The shared fixture, plus the two shapes a real app's save goes through that it does not have:
 * a page whose markup is TWO imports away (page → view → ui leaf), and a slice whose service is
 * imported only by a read the page `load`s — a module that defines a primitive, so pinned.
 */
const FILES: Readonly<Record<string, string>> = {
  ...DEV_FIXTURE_FILES,
  'apps/web/app/deep/ui-deep.tsx': `export function Deep() {
  return <b>deep one</b>;
}
`,
  'apps/web/app/deep/view.tsx': `import { Deep } from './ui-deep';
export function View() {
  return <section><Deep /></section>;
}
`,
  'apps/web/app/deep/page.tsx': `import { defineRoute } from '@ultimat3/render';
import { View } from './view';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Deep', description: 'A page whose markup is two imports away' }),
});

export function Page() {
  return <main><View /></main>;
}
`,
  // A tag-only ISR page (no TTL): fresh until a bust reaches it — which needs an attached controller.
  'apps/web/site/tagged/page.tsx': `import { tag } from '@ultimat3/cache';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag('post')] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Tagged', description: 'A tag-only isr page a bust must reach' }),
});

export function Page() {
  return <main><p>{\`tagged \${String(Reflect.get(globalThis, '__xIsrProbe') ?? 0)}\`}</p></main>;
}
`,
  'apps/web/app/greet/service.ts': `export const greeting = (): string => 'greeting one';
`,
  'apps/web/app/greet/queries.ts': `import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import { greeting } from './service';
export const greetingRead = query({
  input: t.object({}),
  policy: allow('public'),
  sql: () => from<{ id: string; text: string }>('greetings', () => [{ id: '1', text: greeting() }]).orderBy('id'),
});
`,
  'apps/web/app/greet/page.tsx': `import { defineRoute } from '@ultimat3/render';
import { greetingRead } from './queries';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb' },
  load: () => greetingRead({}),
  meta: () => ({ title: 'Greet', description: 'A page whose slice service is edited' }),
});

export function Page(props: { readonly data: readonly { readonly text: string }[] }) {
  return <main><p>{props.data[0]?.text}</p></main>;
}
`,
};
/** Generous and explicit, for the reason `cmd-dev.test.ts` gives: a hang reports as a hang. */
const BOOT_TIMEOUT_MS = 60_000;

let server: DevServer;
/** Rebound by each test that saves a file, so it can await the tick the watcher turned into. */
let onReload: (file: string) => void = () => undefined;
let onRestart: (pins: readonly StalePin[]) => void = () => undefined;
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
    onRestart: (pins) => onRestart(pins),
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
  // Plan 101 s2-con #1: `x dev` built its ISR controller and never attached it, so `invalidateTags`
  // reached no page and a tag-only one served its first render until the process restarted.
  test(
    'a tag bust marks a tag-only isr page stale, then serves the regenerated body',
    async () => {
      const handle = server.running.server;
      const get = async (): Promise<Response> =>
        (handle as NonNullable<typeof handle>).fetch(new Request('http://dev.test/tagged'));
      try {
        Reflect.set(globalThis, '__xIsrProbe', 1);
        expect(await (await get()).text()).toContain('tagged 1');
        Reflect.set(globalThis, '__xIsrProbe', 2);
        await invalidateTags([tag('post')]);
        const stale = await get();
        expect(stale.headers.get('x-ultimate-isr')).toBe('stale');
        expect(await stale.text()).toContain('tagged 1');
        // The regeneration runs behind the stale answer: polled until it lands, with a deadline,
        // never a fixed wait a loaded runner can outlast.
        let body = '';
        for (const started = Date.now(); Date.now() - started < 10_000; await Bun.sleep(5)) {
          body = await (await get()).text();
          if (body.includes('tagged 2')) break;
        }
        expect(body).toContain('tagged 2');
      } finally {
        Reflect.deleteProperty(globalThis, '__xIsrProbe');
      }
    },
    BOOT_TIMEOUT_MS,
  );

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
  test(
    'an edited leaf two imports below the page is served fresh',
    async () => {
      const file = 'apps/web/app/deep/ui-deep.tsx';
      expect(await page('/deep')).toContain('deep one');
      expect(await save(file, 'deep one', 'deep two')).toBe(file);
      expect(await page('/deep')).toContain('deep two');
    },
    BOOT_TIMEOUT_MS,
  );

  // The half no re-import can serve (notificado.co, 2026-09-29: an admin page's `ui-*.tsx` under
  // `defineAdmin`, a slice's service under its query): the read that imports the service DEFINES a
  // primitive, so it keeps the first service. Until 22.12 this logged "reloaded" and served
  // "greeting one" until a manual restart. Now it is a restart — `cmd-dev-restart.live.test.ts`
  // proves the supervised process serves the save; this proves the in-process half asks for it.
  test(
    'an edited slice service under a read is a restart, never "reloaded" over the old read',
    async () => {
      const file = 'apps/web/app/greet/service.ts';
      expect(await page('/greet')).toContain('greeting one');
      const restarted = new Promise<readonly StalePin[]>((resolve) => {
        onRestart = resolve;
      });
      let reloaded = false;
      onReload = () => {
        reloaded = true;
      };
      await Bun.write(join(ROOT, file), FILES[file]?.replace('greeting one', 'greeting two') ?? '');
      const pins = await restarted;
      expect(pins.map((pin) => relative(ROOT, pin.changed))).toEqual([file]);
      expect(pins.map((pin) => relative(ROOT, pin.pinned))).toEqual([
        'apps/web/app/greet/queries.ts',
      ]);
      expect(reloaded).toBe(false);
    },
    BOOT_TIMEOUT_MS,
  );
});
