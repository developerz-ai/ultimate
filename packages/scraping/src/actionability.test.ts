import { describe, expect, test } from 'bun:test';
import { actionabilityProblem, awaitActionable, isStable } from './actionability';
import { testClock } from './clock';
import type { ElementSnapshot } from './target';

const element = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  tag: 'button',
  attrs: {},
  text: 'Go',
  value: '',
  visible: true,
  enabled: true,
  ...over,
});

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · what "ready" means', () => {
  test('attached asks nothing else', () => {
    expect(
      actionabilityProblem(element({ visible: false }), undefined, 'attached'),
    ).toBeUndefined();
  });

  test('an invisible element is not visible, and a zero-sized one is not either', () => {
    expect(actionabilityProblem(element({ visible: false }), undefined, 'visible')).toBe(
      'not visible',
    );
    expect(
      actionabilityProblem(
        element({ box: { x: 0, y: 0, width: 0, height: 10 } }),
        undefined,
        'visible',
      ),
    ).toBe('has a zero-sized box');
  });

  test('a disabled button is the case every scraper hand-rolls as :not([disabled])', () => {
    expect(actionabilityProblem(element({ enabled: false }), undefined, 'enabled')).toBe(
      'disabled',
    );
  });

  test('an element covered at its own centre is refused, and the reason says so', () => {
    const covered = element({ hitTarget: false });
    expect(actionabilityProblem(covered, covered, 'actionable')).toBe(
      'covered by another element at its centre',
    );
  });

  test('an unknown hit-target is NOT read as covered — that is the no-layout driver', () => {
    const noLayout = element({ hitTarget: undefined });
    expect(actionabilityProblem(noLayout, noLayout, 'actionable')).toBeUndefined();
  });

  test('stability is two observations that agree, never a sleep', () => {
    const first = element({ box: { x: 0, y: 0, width: 10, height: 10 } });
    const moved = element({ box: { x: 4, y: 0, width: 10, height: 10 } });
    expect(isStable(moved, first)).toBe(false);
    expect(isStable(moved, moved)).toBe(true);
    expect(isStable(first, undefined)).toBe(false);
    // No box, so the DOM-only drivers compare what they CAN see.
    expect(isStable(element({ text: 'a' }), element({ text: 'b' }))).toBe(false);
  });
});

describe('unit · the two codes are different questions', () => {
  test('an element that never appears is X_SCRAPE_SELECTOR_MISSING', async () => {
    const clock = testClock();
    expect(
      await codeOf(
        awaitActionable({
          selector: '#gone',
          url: 'https://example.test/',
          state: 'actionable',
          timeoutMs: 5_000,
          clock,
          snapshot: () => Promise.resolve(undefined),
        }),
      ),
    ).toBe('X_SCRAPE_SELECTOR_MISSING');
  });

  test('an element that is present and blocked is X_SCRAPE_NOT_ACTIONABLE', async () => {
    // The distinction is the value: "the markup changed" and "a modal is over it" are different
    // afternoons, and one timeout for both is what makes a scraper failure expensive.
    const clock = testClock();
    expect(
      await codeOf(
        awaitActionable({
          selector: '#pay',
          url: 'https://example.test/',
          state: 'actionable',
          timeoutMs: 5_000,
          clock,
          snapshot: () => Promise.resolve(element({ enabled: false })),
        }),
      ),
    ).toBe('X_SCRAPE_NOT_ACTIONABLE');
  });

  test('an element that becomes actionable is returned, and the wait is instant under a test clock', async () => {
    const clock = testClock();
    let polls = 0;
    const found = await awaitActionable({
      selector: '#pay',
      url: 'https://example.test/',
      state: 'actionable',
      timeoutMs: 60_000,
      clock,
      snapshot: () => {
        polls += 1;
        return Promise.resolve(element({ enabled: polls > 3 }));
      },
    });
    expect(found.enabled).toBe(true);
    expect(polls).toBeGreaterThan(3);
  });
});
