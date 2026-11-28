// The dashboard's island, mounted over the markup the server drew: it counts up the figures it was
// given, leaves a figure it was not given alone, and brings the waiting-requests notice in through
// Presence (with `appear`, so it enters rather than just being there).

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';
import * as entry from './dashboard-motion.island';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SHELL =
  '<div data-slot="waiting"></div>' +
  '<p data-stat="dashboard-posts">12</p><p data-stat="dashboard-likes">340</p>' +
  '<ul><li data-reveal="">a</li><li data-reveal="">b</li></ul>';

let mounted: MountedIsland;

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: 'apps/web/app/dashboard/dashboard-motion.island.tsx',
    props: {
      locale: 'en',
      counts: { 'dashboard-posts': 12, 'dashboard-absent': 3 },
      waiting: { text: '2 friend requests are waiting on you', href: '/friends' },
    },
    shell: SHELL,
  });
}, 60_000);

afterAll(() => mounted?.[Symbol.dispose]());

describe('the dashboard motion island', () => {
  test('exports the mount the hydration runtime calls', () => {
    expect(typeof entry.mount).toBe('function');
  });

  test('a figure it was given a count for is drawn by CountUp, counting up from zero', () => {
    expect(mounted.find('[data-stat="dashboard-posts"] [data-effect-backend]')).not.toBeNull();
    expect(mounted.text('[data-stat="dashboard-posts"]')).toBe('0');
  });

  test('a figure it was given no count for keeps the server text', () => {
    expect(mounted.find('[data-stat="dashboard-likes"] [data-effect-backend]')).toBeNull();
    expect(mounted.text('[data-stat="dashboard-likes"]')).toBe('340');
  });

  test('the waiting notice is a link in a Presence, carrying the server-translated text', () => {
    expect(mounted.text('[data-slot="waiting"] [data-presence] a')).toBe(
      '2 friend requests are waiting on you',
    );
    expect(mounted.find('[data-slot="waiting"] a')?.getAttribute('href')).toBe('/friends');
  });
});
