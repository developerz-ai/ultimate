// What a component capture CLAIMS, and the two facts it now records without claiming anything at
// all. A console warning and a box its content overflows are the most common signals a reviewer
// wants and the worst things to gate on — a signal that fails a run is a signal an author
// switches off — so both are asserted here as recorded AND as not reaching `ok`.

import { describe, expect, test } from 'bun:test';
import {
  buildIslandVerdict,
  ISLAND_BLIND_SPOTS,
  ISLAND_SHOT_MESSAGE_KEYS,
  type IslandStateShot,
  islandVerdictJson,
  stateShotOk,
  stateShotWarnings,
} from './island-verdict';
import { messageKeys, msg } from './messages';

const shot = (over: Partial<IslandStateShot> = {}): IslandStateShot => ({
  state: 'empty-options',
  theme: 'light',
  file: 'settings/empty-options-light.png',
  bytes: 4096,
  box: { x: 0, y: 0, width: 420, height: 260 },
  mounted: true,
  unstubbed: [],
  console: [],
  pageErrors: [],
  overflow: { x: false, y: false },
  ...over,
});

describe('unit · a warning is recorded and never gates', () => {
  const warned = shot({
    console: [
      { level: 'warn', text: 'deprecated prop', at: 1 },
      { level: 'log', text: 'hello', at: 2 },
    ],
  });

  test('the warning is counted, and the log line beside it is not', () => {
    expect(stateShotWarnings(warned).map((line) => line.text)).toEqual(['deprecated prop']);
  });

  test('a warned state is still ok, and an ERROR in the same position is not', () => {
    expect(stateShotOk(warned)).toBe(true);
    expect(stateShotOk(shot({ console: [{ level: 'error', text: 'boom', at: 1 }] }))).toBe(false);
  });

  test('an overflowing box is recorded and is still ok', () => {
    expect(stateShotOk(shot({ overflow: { x: true, y: true } }))).toBe(true);
  });

  test('--json carries both counts, so a reader can judge what the gate would not', () => {
    const verdict = buildIslandVerdict({
      island: 'apps/web/app/settings/settings.island.tsx',
      name: 'settings',
      server: 'booted',
      capturedAt: '2026-01-01T00:00:00.000Z',
      expected: [],
      shots: [shot({ ...warned, overflow: { x: true, y: false } })],
      missing: [],
    });
    const json = islandVerdictJson(verdict) as { states: readonly Record<string, unknown>[] };

    expect(json.states[0]).toMatchObject({
      ok: true,
      warnings: 1,
      overflow: { x: true, y: false },
    });
  });
});

/**
 * RED until `messages.ts` carries the rows below — deliberately, and the same mechanism
 * `shot-verdict.test.ts` already uses. `msg()` renders `⟦key⟧` for a miss, which is loud in a
 * terminal and silent to a build, so a test naming the set is the only thing that can see one.
 *
 *   'cli.shot.island.index': '  index    {path}',
 *
 * and `cli.shot.island.blind.crop` rewritten, because the clip is no longer the box exactly:
 *
 *   'the picture is the crop target and a thin margin around it — anything further out, including
 *    the space a component's own fault sits in, is outside the frame; content that overflows the
 *    box is recorded per state as overflow, never shown'
 */
describe('unit · every key x shot --island renders is in the catalog', () => {
  test('no rendered line falls back to ⟦key⟧', () => {
    const known = new Set(messageKeys());
    expect(ISLAND_SHOT_MESSAGE_KEYS.filter((key) => !known.has(key))).toEqual([]);
  });

  /**
   * A stale blind spot is worse than none: it tells a reader the tool cannot see something it now
   * can, or — as here — that the frame is tighter than it is. The crop grew a margin and overflow
   * became a recorded fact, so the sentence that described neither has to go.
   */
  test('the crop blind spot describes the crop this build takes', () => {
    const crop = msg(ISLAND_BLIND_SPOTS[0]);
    expect(crop).not.toContain('nothing around it');
    expect(crop).toContain('overflow');
  });
});
