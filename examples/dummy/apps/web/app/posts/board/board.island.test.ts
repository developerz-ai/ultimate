// The board island the browser runs: it replaces the server's board, and what it ships carries the
// motion engine a card moving between columns plays with.

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
import { boardStates } from './board.island.states';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const idle = boardStates.states.find((state) => state.id === 'idle');

let mounted: MountedIsland;

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: 'apps/web/app/posts/board/board.island.tsx',
    props: idle?.props,
    shell: '<div data-role="shell">board</div>',
  });
}, 60_000);

afterAll(() => mounted?.[Symbol.dispose]());

describe('the board island', () => {
  test('replaces the server shell with the three columns', () => {
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    expect(mounted.all('section')).toHaveLength(3);
  });

  // The micro-DOM lays nothing out, so a sortable list draws no rows here (the same is true of the
  // island without motion); what it CAN show is that the chunk the browser gets carries the
  // Presence wrapper every card is drawn in and the FLIP the move runs through.
  test('the shipped chunk wraps every card in Presence and moves them with layout()', () => {
    expect(mounted.code).toContain('data-presence');
    expect(mounted.code).toContain('getBoundingClientRect');
  });
});
