// The WCAG 2.2.2 pause, wired: the server renders a real button named for what a press does, and a
// press writes the attribute the CSS guard and `motionAllowed()` both read.

import { afterEach, describe, expect, test } from 'bun:test';
import { byTag, fire, one, renderNodes } from '@ultimat3/core/render-nodes';
import { installGlobals } from '../browser-fake-fixture';
import '../theme/ambient';
import { MotionToggle } from './MotionToggle';

let restore = (): void => {};
afterEach(() => restore());

describe('<MotionToggle>', () => {
  test('renders a type="button" named by the pause key while the page moves', () => {
    const button = one(byTag(renderNodes(MotionToggle, {}), 'button'), 'the toggle');
    expect(button.props['type']).toBe('button');
    expect(button.props['data-motion-toggle']).toBe('running');
    expect(JSON.stringify(button)).toContain('Pause animations');
  });

  test('a press pauses the page: html[data-motion="paused"] and the stored choice', () => {
    const attrs = new Map<string, string>();
    const stored = new Map<string, string>();
    // A document and no window: `solid()` stays inert, so the press is the only thing that runs.
    restore = installGlobals({
      document: {
        documentElement: {
          getAttribute: (name: string) => attrs.get(name) ?? null,
          setAttribute: (name: string, value: string) => attrs.set(name, value),
          removeAttribute: (name: string) => attrs.delete(name),
        },
      },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    const button = one(byTag(renderNodes(MotionToggle, {}), 'button'), 'the toggle');
    fire(button, 'onClick', {});
    expect(attrs.get('data-motion')).toBe('paused');
    expect([...stored.values()]).toEqual(['paused']);
  });
});
