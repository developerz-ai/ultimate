// The index is the artifact an agent opens instead of forty PNGs, so what it must CARRY is what is
// asserted here: the note that says why a state is unreachable by clicking, the source path, every
// picture, and a per-state verdict. Pure input, pure output — no disk, no browser, no server.

import { describe, expect, test } from 'bun:test';
import type { IslandStatesManifest } from '@ultimat3/testing';
import { defineIslandStates, islandShotTargets } from '@ultimat3/testing';
import { ISLAND_INDEX, renderIslandIndex } from './island-shot-index';
import type { IslandStateShot, IslandVerdict } from './island-verdict';
import { buildIslandVerdict } from './island-verdict';

const NOTE = 'you cannot reach this by clicking, because the quota endpoint never answers empty';

const manifest: IslandStatesManifest = defineIslandStates({
  island: 'apps/web/app/settings/settings.island.tsx',
  states: [
    {
      id: 'empty-options',
      title: 'the options read answered nothing',
      note: NOTE,
      props: { locales: [] },
    },
    { id: 'save-failed', title: 'the save came back 500', props: {}, themes: ['light'] },
  ],
});

const shot = (
  state: string,
  theme: string,
  over: Partial<IslandStateShot> = {},
): IslandStateShot => ({
  state,
  theme,
  file: `settings/${state}-${theme}.png`,
  bytes: 4096,
  box: { x: 0, y: 0, width: 420, height: 260 },
  mounted: true,
  unstubbed: [],
  console: [],
  pageErrors: [],
  overflow: { x: false, y: false },
  ...over,
});

const verdictOf = (shots: readonly IslandStateShot[], missing: readonly string[]): IslandVerdict =>
  buildIslandVerdict({
    island: manifest.island,
    name: manifest.name,
    server: 'booted',
    capturedAt: '2026-01-01T00:00:00.000Z',
    expected: islandShotTargets(manifest),
    shots,
    missing,
  });

const clean = (): IslandVerdict =>
  verdictOf(
    [shot('empty-options', 'light'), shot('empty-options', 'dark'), shot('save-failed', 'light')],
    [],
  );

const render = (verdict: IslandVerdict): string =>
  renderIslandIndex({
    pairs: [{ manifest, verdict }],
    capturedAt: '2026-01-01T00:00:00.000Z',
    blind: ['the picture is the crop target and a little of what surrounds it'],
  });

describe('unit · the index says what each picture IS', () => {
  test('every state carries its id, its title, its note and one path per theme', () => {
    const index = render(clean());

    expect(index).toContain('settings');
    // The source path, so a reader can open the component the pictures are of.
    expect(index).toContain('apps/web/app/settings/settings.island.tsx');
    expect(index).toContain('empty-options');
    expect(index).toContain('the options read answered nothing');
    // The whole reason a reviewer knows what they are looking at.
    expect(index).toContain(NOTE);
    expect(index).toContain('settings/empty-options-light.png');
    expect(index).toContain('settings/empty-options-dark.png');
    expect(index).toContain('settings/save-failed-light.png');
  });

  test('the header counts islands, states and pictures, and names the re-run', () => {
    const whole = render(clean());
    const header = whole.split('\n').slice(0, 16).join('\n');

    expect(header).toContain('1 island');
    expect(header).toContain('2 state');
    expect(header).toContain('3 picture');
    expect(header).toContain('x shot --all-islands');
    expect(header).toContain('x shot --island <name> --json');
    // And every state carries the invocation that reproduces exactly that one picture set.
    expect(whole).toContain('x shot --island settings --state empty-options --json');
  });

  test('what the capture could not see is carried, never dropped', () => {
    expect(render(clean())).toContain('the picture is the crop target');
  });
});

describe('unit · a state that failed says so, beside the picture it did not get', () => {
  test('a missing picture and a console error are both named', () => {
    const index = render(
      verdictOf(
        [
          shot('empty-options', 'light', {
            console: [{ level: 'error', text: 'boom', at: 1 }],
          }),
          shot('save-failed', 'light'),
        ],
        ['settings/empty-options-dark.png'],
      ),
    );

    expect(index).toContain('console error');
    expect(index).toContain('no picture');
    // The clean state is still reported clean — a run is not one verdict.
    expect(index).toContain('save-failed');
  });

  /**
   * The two facts that are RECORDED and must never gate. A warning that failed a run is a warning
   * an author switches off, so the index reports both and the verdict's `ok` ignores both.
   */
  test('a warning and an overflowing box are reported without failing the state', () => {
    const noisy = verdictOf(
      [
        shot('empty-options', 'light', {
          console: [{ level: 'warn', text: 'deprecated', at: 1 }],
          overflow: { x: true, y: false },
        }),
        shot('empty-options', 'dark'),
        shot('save-failed', 'light'),
      ],
      [],
    );
    const index = render(noisy);

    expect(noisy.ok).toBe(true);
    expect(index).toContain('1 console warning');
    expect(index).toContain('overflow');
  });
});

describe('unit · the index is one file, named once', () => {
  test('the filename is a constant nobody restates', () => {
    expect(ISLAND_INDEX).toBe('index.md');
  });
});
