import { describe, expect, test } from 'bun:test';
import { FakeHost } from '../fake-host-fixture';
import { tiltMove, tiltRest } from './tilt-wire';

function target(trapped = false) {
  const props = new Map<string, string>();
  return {
    props,
    closest: () => (trapped ? {} : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    style: {
      setProperty: (n: string, v: string) => void props.set(n, v),
      removeProperty: (n: string) => void props.delete(n),
    },
  };
}
const mouse = { pointerType: 'mouse', clientX: 200, clientY: 0 };

describe('tiltMove', () => {
  test('a mouse at the corner leans to the cap, no further', () => {
    const el = target();
    tiltMove(el, mouse, 10, new FakeHost());
    expect([...el.props]).toEqual([
      ['--tilt-x', '10deg'],
      ['--tilt-y', '10deg'],
    ]);
  });

  test.each([
    ['touch', { ...mouse, pointerType: 'touch' }, false, true],
    ['inside a focus trap', mouse, true, true],
    ['reduced motion', mouse, false, false],
  ])('%s: flat, whatever was set before', (_n, pointer, trapped, allowed) => {
    const el = target(trapped);
    el.props.set('--tilt-x', '5deg');
    const host = new FakeHost();
    host.allowedNow = allowed;
    tiltMove(el, pointer, 10, host);
    expect(el.props.size).toBe(0);
  });

  test('rest clears both angles', () => {
    const el = target();
    el.props.set('--tilt-x', '1deg');
    el.props.set('--tilt-y', '1deg');
    tiltRest(el);
    expect(el.props.size).toBe(0);
  });
});
