// Pins the per-island directive → markup/runtime contract: `never` must stay inert and cost
// nothing, the other strategies must each emit exactly their own runtime block, in a fixed
// order regardless of directive order, and `hydrateRuntimeBytes` must agree with the runtime text.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REPLAY_EVENTS,
  emitIslandAttributes,
  emitIslandProps,
  hydrateRuntime,
  hydrateRuntimeBytes,
  type IslandDirective,
  requiredStrategies,
} from './hydrate';

const directive = (overrides: Partial<IslandDirective> = {}): IslandDirective => ({
  islandId: 'x1',
  strategy: 'idle',
  entry: '/chunks/x1.js',
  ...overrides,
});

describe('emitIslandAttributes', () => {
  test('strategy "never" emits only data-x-island and data-x-hydrate', () => {
    const attrs = emitIslandAttributes(
      directive({
        strategy: 'never',
        entry: '/chunks/x1.js',
        rootMargin: '200px',
        events: ['click'],
      }),
    );
    expect(attrs).toBe('data-x-island="x1" data-x-hydrate="never"');
    expect(attrs).not.toContain('data-x-entry');
    expect(attrs).not.toContain('data-x-margin');
    expect(attrs).not.toContain('data-x-events');
  });

  test('a non-never strategy includes data-x-entry', () => {
    const attrs = emitIslandAttributes(directive({ strategy: 'idle' }));
    expect(attrs).toContain('data-x-entry="/chunks/x1.js"');
  });

  test('rootMargin is included only when set and strategy is not never', () => {
    const withMargin = emitIslandAttributes(directive({ strategy: 'visible', rootMargin: '50px' }));
    expect(withMargin).toContain('data-x-margin="50px"');

    const withoutMargin = emitIslandAttributes(directive({ strategy: 'visible' }));
    expect(withoutMargin).not.toContain('data-x-margin');
  });

  test('events is included as a space-joined attr only when non-empty', () => {
    const withEvents = emitIslandAttributes(
      directive({ strategy: 'interaction', events: ['click', 'keydown'] }),
    );
    expect(withEvents).toContain('data-x-events="click keydown"');

    const emptyEvents = emitIslandAttributes(directive({ strategy: 'interaction', events: [] }));
    expect(emptyEvents).not.toContain('data-x-events');
  });
});

describe('emitIslandProps', () => {
  test('no props produces an empty string', () => {
    expect(emitIslandProps(directive({ strategy: 'idle' }))).toBe('');
  });

  test('strategy "never" produces an empty string even with props set', () => {
    expect(emitIslandProps(directive({ strategy: 'never', props: { a: 1 } }))).toBe('');
  });

  test('otherwise renders a JSON props script tag keyed by islandId', () => {
    const html = emitIslandProps(directive({ islandId: 'x2', strategy: 'idle', props: { a: 1 } }));
    expect(html).toBe('<script type="application/json" data-x-props="x2">{"a":1}</script>');
  });

  test('a "<" inside a prop value is escaped to \\u003c, not left raw', () => {
    const html = emitIslandProps(directive({ strategy: 'idle', props: { html: '<script>' } }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('\\u003cscript>');
  });
});

describe('requiredStrategies', () => {
  test('returns the distinct non-never strategies present', () => {
    const set = requiredStrategies([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'idle' }),
    ]);
    expect(set).toEqual(new Set(['idle', 'visible']));
  });

  test('never directives contribute nothing', () => {
    const set = requiredStrategies([directive({ strategy: 'never' })]);
    expect(set).toEqual(new Set());
  });

  test('empty input produces an empty set', () => {
    expect(requiredStrategies([])).toEqual(new Set());
  });
});

describe('hydrateRuntime', () => {
  test('empty directives produce the empty string', () => {
    expect(hydrateRuntime([])).toBe('');
  });

  test('all-never directives produce the empty string', () => {
    expect(hydrateRuntime([directive({ strategy: 'never' })])).toBe('');
  });

  test('only "idle" requested emits the idle block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'idle' })]);
    expect(html).toContain('data-x-hydrate="idle"');
    expect(html).toContain('requestIdleCallback');
    expect(html).not.toContain('IntersectionObserver');
    expect(html).not.toContain('data-x-hydrate="interaction"');
  });

  test('only "visible" requested emits the visible block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'visible' })]);
    expect(html).toContain('data-x-hydrate="visible"');
    expect(html).toContain('IntersectionObserver');
    expect(html).not.toContain('requestIdleCallback');
    expect(html).not.toContain('data-x-hydrate="interaction"');
  });

  test('only "interaction" requested emits the interaction block and not the others', () => {
    const html = hydrateRuntime([directive({ strategy: 'interaction' })]);
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html).not.toContain('requestIdleCallback');
    expect(html).not.toContain('IntersectionObserver');
  });

  test('all three strategies present emit all three markers wrapped in one module script', () => {
    const html = hydrateRuntime([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'interaction' }),
    ]);
    expect(html).toContain('requestIdleCallback');
    expect(html).toContain('IntersectionObserver');
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html.startsWith('<script type="module">')).toBe(true);
    expect(html.endsWith('</script>')).toBe(true);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  test('output order is idle, visible, interaction regardless of input order', () => {
    const inOrder = hydrateRuntime([
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
      directive({ strategy: 'interaction' }),
    ]);
    const scrambled = hydrateRuntime([
      directive({ strategy: 'interaction' }),
      directive({ strategy: 'idle' }),
      directive({ strategy: 'visible' }),
    ]);
    expect(scrambled).toBe(inOrder);

    const idleAt = scrambled.indexOf('requestIdleCallback');
    const visibleAt = scrambled.indexOf('IntersectionObserver');
    const interactionAt = scrambled.indexOf('data-x-hydrate="interaction"');
    expect(idleAt).toBeGreaterThan(-1);
    expect(visibleAt).toBeGreaterThan(idleAt);
    expect(interactionAt).toBeGreaterThan(visibleAt);
  });
});

describe('hydrateRuntimeBytes', () => {
  test('is 0 for directives that emit no runtime', () => {
    expect(hydrateRuntimeBytes([])).toBe(0);
    expect(hydrateRuntimeBytes([directive({ strategy: 'never' })])).toBe(0);
  });

  test("agrees with TextEncoder over hydrateRuntime's own output", () => {
    const directives = [
      directive({ strategy: 'idle' }),
      directive({ strategy: 'interaction', events: ['click'] }),
    ];
    const expected = new TextEncoder().encode(hydrateRuntime(directives)).byteLength;
    expect(hydrateRuntimeBytes(directives)).toBe(expected);
  });
});

describe('DEFAULT_REPLAY_EVENTS', () => {
  test('is the exact default replay event list', () => {
    expect(DEFAULT_REPLAY_EVENTS).toEqual(['click', 'input', 'change', 'submit', 'keydown']);
  });
});
