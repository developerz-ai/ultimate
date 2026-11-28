// The motion island `--shape dashboard` writes, built and mounted the way the browser runs it: the
// shell is replaced, a click opens the Presence panel and flips the label, a second click closes it,
// and the chunk carries Solid's compiled output, not the classic React factory.

import { describe, expect, test } from 'bun:test';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from '../../island-bundle';
import { fixtureAppRoot } from '../island-fixture';
import { dashboardMotionFiles } from './dashboard-motion';

const ENTRY = 'apps/web/app/dashboard/dashboard-motion.island.tsx';
const PROPS = { open: 'Show tips', close: 'Hide tips', note: 'The note' };

describe('unit · the dashboard motion island mounts', () => {
  test('a click opens the panel through Presence, and the next one closes it', async () => {
    using root = await fixtureAppRoot('dashboard-motion', dashboardMotionFiles());
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: PROPS,
      shell: '<button type="button">Show tips</button>',
    });
    expect(mounted.code).not.toMatch(/\bReact\b/);
    expect(mounted.text('button')).toBe('Show tips');
    expect(mounted.find('[data-presence]')).toBeNull();
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('button')).toBe('Hide tips');
    expect(mounted.text('[data-presence]')).toBe('The note');
  }, 60_000);

  // The mutation, run: without Presence around the note, the panel never appears.
  test('a panel that is not Presence fails the same assertion', async () => {
    const emitted = dashboardMotionFiles().map((file) =>
      file.path === ENTRY
        ? {
            ...file,
            contents: String(file.contents).replace(
              '<Presence when={shown()}',
              '<Presence when={false}',
            ),
          }
        : file,
    );
    using root = await fixtureAppRoot('dashboard-motion-inert', emitted);
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: PROPS,
    });
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('[data-presence]')).toBe('');
  }, 60_000);
});
