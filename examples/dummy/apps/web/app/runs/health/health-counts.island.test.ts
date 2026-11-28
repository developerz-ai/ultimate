// The counts island takes the figures a server page drew and counts them up: the island the
// browser runs, mounted over the server's tiles, counts up the figures it was given and leaves the rest.

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
import * as entry from './health-counts.island';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

let mounted: MountedIsland;

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: 'apps/web/app/runs/health/health-counts.island.tsx',
    props: { locale: 'en', counts: { 'runs-total': 1234, 'runs-missing': 7 } },
    shell: '<p data-stat="runs-total">1,234</p><p data-stat="runs-failed">9</p>',
  });
}, 60_000);

afterAll(() => mounted?.[Symbol.dispose]());

describe('the health counts island', () => {
  test('exports the mount the hydration runtime calls', () => {
    expect(typeof entry.mount).toBe('function');
  });

  test('a figure it was given a count for is drawn by CountUp, counting up from zero', () => {
    expect(mounted.find('[data-stat="runs-total"] [data-effect-backend]')).not.toBeNull();
    expect(mounted.text('[data-stat="runs-total"]')).toBe('0');
  });

  test('a figure it was given no count for keeps the server text, and a stat the page lacks is skipped', () => {
    expect(mounted.find('[data-stat="runs-failed"] [data-effect-backend]')).toBeNull();
    expect(mounted.text('[data-stat="runs-failed"]')).toBe('9');
  });
});
