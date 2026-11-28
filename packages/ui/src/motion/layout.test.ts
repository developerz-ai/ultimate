// FLIP: measure every element (First), let the change land (Last), Invert with a transform, Play
// to none. Every read happens before any write, so a list of fifty forces two layouts, not fifty.

import { describe, expect, test } from 'bun:test';
import { invertBox, layout } from './layout';

const box = (left: number, top: number, width = 100, height = 50) => ({ left, top, width, height });

describe('invertBox', () => {
  test('translates the last box back onto the first', () => {
    expect(invertBox(box(10, 200), box(10, 50), false)).toEqual({ x: 0, y: 150 });
  });

  test('with scale, also sizes it back, from the top-left corner', () => {
    expect(invertBox(box(0, 0, 200, 100), box(20, 10, 100, 50), true)).toEqual({
      x: -20,
      y: -10,
      scaleX: 2,
      scaleY: 2,
      origin: '0 0',
    });
  });

  test('an element that did not move needs no animation', () => {
    expect(invertBox(box(5, 5), box(5, 5), true)).toBeNull();
  });

  test('a zero-size last box is never divided by', () => {
    expect(invertBox(box(0, 0, 100, 50), box(0, 0, 0, 0), true)).toBeNull();
  });
});

describe('layout', () => {
  test('reads every box, runs the change, reads every box, THEN animates — batched', async () => {
    const log: string[] = [];
    let moved = false;
    const element = (name: string, before: number, after: number) =>
      ({
        getBoundingClientRect() {
          log.push(`read ${name}`);
          return box(0, moved ? after : before);
        },
        animate(keyframes: Keyframe[]) {
          log.push(`animate ${name} ${JSON.stringify(keyframes[0])}`);
          return { finished: Promise.resolve(), cancel() {}, reverse() {} };
        },
      }) as unknown as Element;
    const a = element('a', 0, 60);
    const b = element('b', 60, 0);
    const still = element('c', 120, 120);
    const handle = layout([a, b, still], () => {
      log.push('change');
      moved = true;
    });
    await handle.finished;
    expect(log).toEqual([
      'read a',
      'read b',
      'read c',
      'change',
      'read a',
      'read b',
      'read c',
      'animate a {"transform":"translate(0px, -60px)"}',
      'animate b {"transform":"translate(0px, 60px)"}',
    ]);
  });
});
