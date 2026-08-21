// The island the browser actually runs: `mountIsland` builds `settings.island.tsx` with the same
// `buildIslands` `x build` and `x dev` use, imports the emitted chunk the way the hydration runtime
// does, and drives `mount` against a DOM small enough to read. Anything less proves the file
// exists — and a file that exists is exactly what shipped, dead, through five majors.
//
// Both imports are PUBLIC package specifiers, which is the point: this test is one an app outside
// this monorepo can write. It reached six levels up into `packages/cli/src/island-bundle` until
// 2026-08-21, and nothing off the framework's own disk could do that (issue #260).

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type FakeElement,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const NOW = '2026-03-14T08:30:00.000Z';
const ENDPOINT = '/api/settings/save-preferences';

const option = (value: string): { value: string; label: string } => ({ value, label: value });

const PROPS = {
  endpoint: ENDPOINT,
  nowIso: NOW,
  locale: 'en',
  timezone: 'UTC',
  theme: 'system',
  digestOptIn: true,
  locales: ['en', 'es'].map(option),
  timezones: ['UTC', 'Asia/Tokyo'].map(option),
  themes: ['system', 'light', 'dark'].map(option),
  labels: {
    locale: 'Language',
    localeHelp: 'Applies to the interface.',
    timezone: 'Timezone',
    timezoneHelp: 'Every date you see is rendered in this zone.',
    theme: 'Theme',
    digest: 'Nightly digest',
    digestHelp: 'One email at 09:00 your time.',
    save: 'Save',
    saved: 'Saved',
    retry: 'Try again',
  },
} as const;

/** What the island must produce for a zone — computed here rather than pasted, so the assertion
 *  survives an ICU data bump and still fails when the zone stops reaching the formatter. */
const expectedPreview = (locale: string, zone: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(NOW));

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const calls: FetchCall[] = [];
let ok = true;

let mounted: MountedIsland;

/** `<select>`s in document order: language, timezone, theme. */
const selectAt = (index: number): FakeElement => mounted.all('select')[index] as FakeElement;

const choose = (select: FakeElement, value: string): void => {
  select.value = value;
  mounted.fire(select, 'change');
};

/** Build the real chunk once — Babel plus a browser bundle is seconds, and every case shares it. */
beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    // The shell the page server-renders. `mount` replaces it, which is the first assertion below.
    shell: '<dl><dt>Language</dt><dd>en</dd></dl>',
    globals: {
      fetch: (url: string, init: { body: string }): Promise<{ ok: boolean }> => {
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return Promise.resolve({ ok });
      },
    },
  });
}, 60_000);

// The fake `document` is process-global: left installed it reaches every LATER FILE in the run.
// `?.` because a `beforeAll` that threw leaves `mounted` unassigned, and an unguarded dispose then
// adds a meaningless `TypeError` AFTER the coded cause — bun prints both, so the real error is the
// one that scrolls away. The type stays `MountedIsland`, not `| undefined`: widening it reds every
// `mounted.…` read below with TS18048.
afterAll(() => {
  mounted?.[Symbol.dispose]();
});

/**
 * One mount, driven as a session: the cases below run in order against the same island, because
 * building the real chunk is a Babel pass plus a browser bundle and repeating it per case would
 * pay seconds for state each case sets up anyway.
 *
 * Declaration order is therefore LOAD-BEARING, not incidental — each case continues the selection
 * the last one left, and `save` posts all three at once. `bun test --randomize` reds this file
 * (measured: `--seed=7` reds the status case), and that is the price of one mount rather than a
 * defect to route around. What a case may not do is paste a value a SIBLING chose: it reads it
 * from the control instead, so a failure names the case that broke and not the one after it.
 */
describe('the settings island', () => {
  test('mount replaces the server shell with the editor', () => {
    expect(mounted.find('dl')).toBeNull();
    expect(mounted.all('select')).toHaveLength(3);
    expect(mounted.all('button')).toHaveLength(1);
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('the preview re-renders in the zone the member just picked', () => {
    expect(mounted.text('[data-role="preview"]')).toBe(expectedPreview('en', 'UTC'));

    choose(selectAt(1), 'Asia/Tokyo');

    // The one assertion that a compile-time reactivity contract either honours or silently drops:
    // an eager JSX factory hands the formatter an evaluated string once and never runs it again.
    expect(mounted.text('[data-role="preview"]')).toBe(expectedPreview('en', 'Asia/Tokyo'));
    expect(mounted.text('[data-role="preview"]')).not.toBe(expectedPreview('en', 'UTC'));
  });

  test('the locale reaches the same preview, so both signals are tracked', () => {
    // The zone the case above left selected, read rather than pasted: a literal here would be this
    // case asserting a sibling's outcome as its own premise.
    const zone = selectAt(1).value;
    choose(selectAt(0), 'es');
    expect(mounted.text('[data-role="preview"]')).toBe(expectedPreview('es', zone));
  });

  test("theme writes <html data-theme> at once, and 'system' takes it back off", () => {
    choose(selectAt(2), 'dark');
    expect(mounted.documentElement.dataset['theme']).toBe('dark');

    choose(selectAt(2), 'system');
    // Removed, never set to '': `system` means the inline head script and the OS decide again,
    // and an empty attribute is still an attribute the CSS selector matches.
    expect('theme' in mounted.documentElement.dataset).toBe(false);
  });

  test('save posts the CURRENT selection to the path the server minted', async () => {
    expect(mounted.fire('button', 'click')).toBe(true);
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    // The values the three changes above left behind, not the props the island booted with.
    expect(calls[0]?.body).toEqual({
      locale: 'es',
      tz: 'Asia/Tokyo',
      theme: 'system',
      digestOptIn: true,
    });
  });

  test('the status line answers the response, both ways', async () => {
    expect(mounted.text('[data-role="status"]')).toBe(PROPS.labels.saved);

    ok = false;
    mounted.fire('button', 'click');
    await Promise.resolve();
    await Promise.resolve();

    expect(mounted.text('[data-role="status"]')).toBe(PROPS.labels.retry);
  });
});
