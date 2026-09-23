import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import type { UiInteractInput } from '@ultimat3/mcp';
import { fakeShotDriver } from './browser-launcher-fake';
import type { ShotDriver, ShotPage } from './browser-launcher-port';
import { uiCapabilities } from './mcp-ui';
import { ACTIVE_FIELD_TYPE, interactRoute, parseSteps, stepsHash } from './mcp-ui-interact';
import { ISLAND_PROBE } from './shot-verdict';
import { inspectExpression } from './ui-inspect-probe';

const SERVER_URL = 'http://localhost:4321';
const CLEAN = JSON.stringify({
  declared: 1,
  booted: 1,
  mounted: 1,
  failed: 0,
  byStrategy: { idle: 1 },
  failures: [],
});
const DASH =
  '<!doctype html><html data-theme="dark"><head><title>Dash</title></head><body>' +
  '<button id="next" data-goto="/next">Next</button>' +
  '<button id="away" data-goto="https://evil.example/">Away</button>' +
  '<input id="q" type="search"><input id="pw" type="password">' +
  '<div data-x-island="i1" data-x-hydrate="idle"></div></body></html>';
const NEXT =
  '<!doctype html><html><head><title>Next</title></head><body><h1>Next</h1></body></html>';

const INPUT: UiInteractInput = {
  route: '/dash',
  viewport: { width: 390, height: 844 },
  colorScheme: 'dark',
  fullPage: false,
  steps: [],
};

const boot = async () => ({
  url: SERVER_URL,
  origin: 'booted' as const,
  stop: async () => undefined,
});
const noSleep = async (): Promise<void> => undefined;

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = `${process.env['TMPDIR'] ?? '/tmp'}/ui-interact-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  try {
    return await run(root);
  } finally {
    await Bun.$`rm -rf ${root}`.quiet();
  }
}

const site = (extra: readonly { url: string; html: string }[] = []): ShotDriver =>
  fakeShotDriver([
    {
      url: `${SERVER_URL}/dash`,
      html: DASH,
      evaluate: { [ISLAND_PROBE]: CLEAN, [ACTIVE_FIELD_TYPE]: 'null' },
    },
    {
      url: `${SERVER_URL}/next`,
      html: NEXT,
      evaluate: { [ISLAND_PROBE]: CLEAN, [ACTIVE_FIELD_TYPE]: 'null' },
    },
    ...extra,
  ]);

const run = (root: string, input: Partial<UiInteractInput>, driver: ShotDriver = site()) =>
  interactRoute({ root, boot, driver: async () => driver, sleep: noSleep }, { ...INPUT, ...input });

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return 'no error';
};

describe('unit · ui.interact drives the route, then photographs it', () => {
  test('a click that navigates same-origin is reported, and lands under interact-<hash>', async () => {
    await withRoot(async (root) => {
      const steps = [{ click: '#next' }];
      const result = await run(root, { steps });
      expect(result.steps).toEqual([
        {
          index: 0,
          kind: 'click',
          ms: expect.any(Number),
          navigated: true,
          url: `${SERVER_URL}/next`,
        },
      ]);
      expect(result.finalUrl).toBe(`${SERVER_URL}/next`);
      // A navigation a STEP caused is not the redirect the verdict fails a capture for.
      expect(result.ok).toBe(true);
      expect((result.verdict as { redirected: boolean }).redirected).toBe(true);
      expect(result.image).toContain(`390x844-dark/interact-${stepsHash(steps)}/shot.png`);
      expect(result.image).not.toContain('/inspect/');
      expect(await Bun.file(result.verdictFile).exists()).toBe(true);
    });
  });

  test('steps that stay put report navigated: false, and the verdict is ui.shot’s', async () => {
    await withRoot(async (root) => {
      const result = await run(root, {
        steps: [
          { focus: '#q' },
          { type: { selector: '#q', text: 'hello' } },
          { press: 'Enter' },
          { wait: 5 },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.steps.map((step) => [step.kind, step.navigated])).toEqual([
        ['focus', false],
        ['type', false],
        ['press', false],
        ['wait', false],
      ]);
      expect(result.finalUrl).toBe(`${SERVER_URL}/dash`);
    });
  });

  test('the hash is per step list, not per run, and differs between lists', () => {
    expect(stepsHash([{ click: '#a' }])).toBe(stepsHash([{ click: '#a' }]));
    expect(stepsHash([{ click: '#a' }])).not.toBe(stepsHash([{ click: '#b' }]));
    expect(stepsHash([{ click: '#a' }])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('unit · the four refusals', () => {
  test('a cross-origin data-goto is a coded refusal', async () => {
    await withRoot(async (root) => {
      // With the far page recorded, the fake follows it and the origin check fires; without one,
      // the fake's own X_CDP_CALL_FAILED (no page recorded) fires first. Coded either way.
      const recorded = site([{ url: 'https://evil.example/', html: '<p>gone</p>' }]);
      expect(await codeOf(run(root, { steps: [{ click: '#away' }] }, recorded))).toBe(
        'X_UI_INTERACT_LEFT_APP',
      );
      expect(await codeOf(run(root, { steps: [{ click: '#away' }] }))).toBe(
        'X_UI_INTERACT_STEP_FAILED',
      );
    });
  });

  test('X_UI_INTERACT_LEFT_APP, pinned with a driver whose url() answers another origin', async () => {
    await withRoot(async (root) => {
      const inner = site();
      let clicked = false;
      const spy: ShotDriver = {
        name: 'spy',
        async open(init) {
          const session = await inner.open(init);
          const page = new Proxy(session.page, {
            get(target, prop, receiver) {
              if (prop === 'url')
                return () => (clicked ? 'https://elsewhere.example/x' : target.url());
              if (prop === 'click') {
                return async (selector: string) => {
                  clicked = true;
                  await target.click(selector);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return { ...session, page };
        },
      };
      expect(await codeOf(run(root, { steps: [{ click: '#q' }] }, spy))).toBe(
        'X_UI_INTERACT_LEFT_APP',
      );
    });
  });

  test('a password field is refused before any keystroke', async () => {
    await withRoot(async (root) => {
      const inner = site();
      const typed: string[] = [];
      const spy: ShotDriver = {
        name: 'spy',
        async open(init) {
          const session = await inner.open(init);
          const page = new Proxy(session.page, {
            get(target, prop, receiver) {
              if (prop === 'type') {
                return async (selector: string, text: string) => {
                  typed.push(selector);
                  await target.type(selector, text);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return { ...session, page };
        },
      };
      const steps = [
        { type: { selector: '#q', text: 'ok' } },
        { type: { selector: '#pw', text: 'hunter2' } },
      ];
      expect(await codeOf(run(root, { steps }, spy))).toBe('X_UI_INTERACT_SECRET_FIELD');
      expect(typed).toEqual(['#q']);
    });
  });

  // Row ad: `focus` a password field, then `press` its characters one key at a time — the guard
  // read `type` steps only, so eleven presses typed a password it refused to type.
  test('a press while a password field has focus is refused before the key goes out', async () => {
    await withRoot(async (root) => {
      const inner = site();
      const pressed: string[] = [];
      const spy: ShotDriver = {
        name: 'spy',
        async open(init) {
          const session = await inner.open(init);
          const page = new Proxy(session.page, {
            get(target, prop, receiver) {
              if (prop === 'press') {
                return async (chord: string) => {
                  pressed.push(chord);
                };
              }
              if (prop === 'focus') return async () => undefined;
              if (prop === 'evaluate') {
                return async (expression: string) =>
                  expression === ACTIVE_FIELD_TYPE ? 'password' : target.evaluate(expression);
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return { ...session, page };
        },
      };
      const steps = [{ focus: '#pw' }, { press: 'h' }];
      expect(await codeOf(run(root, { steps }, spy))).toBe('X_UI_INTERACT_SECRET_FIELD');
      expect(pressed).toEqual([]);
    });
  });

  test('a missing selector is X_UI_INTERACT_STEP_FAILED naming the step and the driver code', async () => {
    await withRoot(async (root) => {
      // The fake's own click waits the page timeout for a selector that never appears; the spy
      // answers what it would answer, at once.
      const inner = site();
      const spy: ShotDriver = {
        name: 'spy',
        async open(init) {
          const session = await inner.open(init);
          const page = new Proxy(session.page, {
            get(target, prop, receiver) {
              if (prop === 'click') {
                return () => {
                  throw new UltimateError({
                    code: 'X_SHOT_ELEMENT_MISSING',
                    cause: '#nope never appeared',
                    fix: 'x help shot --json',
                  });
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return { ...session, page };
        },
      };
      try {
        await run(root, { steps: [{ wait: 1 }, { click: '#nope' }] }, spy);
        expect.unreachable('the click should have failed');
      } catch (error) {
        if (!isUltimateError(error)) throw error;
        expect(error.code).toBe('X_UI_INTERACT_STEP_FAILED');
        expect(error.cause).toContain('step 1 (click "#nope"): X_SHOT_ELEMENT_MISSING — ');
        expect(error.meta).toEqual({ step: 1, code: 'X_SHOT_ELEMENT_MISSING' });
        expect(error.fix).toContain('--json');
      }
    });
  });

  test('bounds: refused whole, never trimmed', () => {
    const bad = (steps: readonly Readonly<Record<string, unknown>>[]) => {
      try {
        parseSteps(steps);
      } catch (error) {
        return isUltimateError(error) ? error.code : 'not coded';
      }
      return 'accepted';
    };
    expect(bad(Array.from({ length: 13 }, () => ({ wait: 1 })))).toBe(
      'X_UI_INTERACT_STEPS_INVALID',
    );
    expect(bad([{ wait: 5001 }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{ wait: -1 }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{ click: '' }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{ type: { selector: '#q', text: 'x'.repeat(501) } }])).toBe(
      'X_UI_INTERACT_STEPS_INVALID',
    );
    expect(bad([{ type: { selector: '#q' } }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{}])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{ click: '#a', press: 'Enter' }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad([{ hover: '#a' }])).toBe('X_UI_INTERACT_STEPS_INVALID');
    expect(bad(Array.from({ length: 12 }, () => ({ wait: 5000 })))).toBe('accepted');
    expect(parseSteps([{ wait: '#q' }, { press: 'Meta+K' }])).toEqual([
      { kind: 'wait', selector: '#q' },
      { kind: 'press', chord: 'Meta+K' },
    ]);
  });
});

describe('unit · order and the inspect block', () => {
  test('settle → step → settle → … → screenshot, every step followed by its own settle', async () => {
    await withRoot(async (root) => {
      const inner = site();
      const events: string[] = [];
      const spy: ShotDriver = {
        name: 'spy',
        async open(init) {
          const session = await inner.open(init);
          const page = new Proxy(session.page, {
            get(target, prop, receiver) {
              if (prop === 'evaluate') {
                return (expression: string) => {
                  if (expression === ISLAND_PROBE) events.push('settle');
                  return target.evaluate(expression);
                };
              }
              if (prop === 'focus' || prop === 'press') {
                return (arg: string) => {
                  events.push(`step:${String(prop)}`);
                  return prop === 'focus' ? target.focus(arg) : target.press(arg);
                };
              }
              if (prop === 'screenshot') {
                return (options: Parameters<ShotPage['screenshot']>[0]) => {
                  events.push('screenshot');
                  return target.screenshot(options);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return { ...session, page };
        },
      };
      await run(root, { steps: [{ focus: '#q' }, { press: 'Meta+K' }] }, spy);
      expect(events).toEqual([
        'settle',
        'step:focus',
        'settle',
        'step:press',
        'settle',
        'screenshot',
      ]);
    });
  });

  test('the inspect block is read after the steps and round-trips ui.inspect’s shape', async () => {
    await withRoot(async (root) => {
      const inspect = { selectors: ['h1'], styles: ['color'], a11y: false, activeElement: true };
      const answer = JSON.stringify({
        title: 'Next',
        theme: null,
        activeElement: { tag: 'h1', id: '', role: '', name: '' },
        selectors: [
          {
            selector: 'h1',
            valid: true,
            count: 1,
            truncated: false,
            matches: [
              {
                tag: 'h1',
                text: 'Next',
                box: { x: 0, y: 0, width: 10, height: 10 },
                visible: true,
                attrs: {},
                styles: { color: 'red' },
              },
            ],
          },
        ],
      });
      const driver = fakeShotDriver([
        {
          url: `${SERVER_URL}/dash`,
          html: DASH,
          evaluate: { [ISLAND_PROBE]: CLEAN, [ACTIVE_FIELD_TYPE]: 'null' },
        },
        // The facts are recorded on the page the steps LAND on, which proves they are read after.
        {
          url: `${SERVER_URL}/next`,
          html: NEXT,
          evaluate: {
            [ISLAND_PROBE]: CLEAN,
            [ACTIVE_FIELD_TYPE]: 'null',
            [inspectExpression(inspect)]: answer,
          },
        },
      ]);
      const result = await run(root, { steps: [{ click: '#next' }], inspect }, driver);
      expect(result.inspect?.title).toBe('Next');
      expect(result.inspect?.activeElement).toEqual({ tag: 'h1', id: '', role: '', name: '' });
      expect(result.inspect?.selectors[0]?.matches[0]?.styles).toEqual({ color: 'red' });
      expect(result.inspect?.truncated).toBe(false);
    });
  });

  test('through uiCapabilities: the same route gate as the other ui.* tools', async () => {
    await withRoot(async (root) => {
      const ui = uiCapabilities({
        root,
        env: {},
        boot,
        driver: async () => site(),
        routes: () => [{ path: '/dash', file: 'apps/web/app/dash/page.tsx', budgetJs: '10kb' }],
      });
      expect(
        await codeOf(ui.interactRoute({ ...INPUT, route: '/nope', steps: [{ wait: 1 }] })),
      ).toBe('X_UI_SHOT_ROUTE_UNKNOWN');
      const result = await ui.interactRoute({ ...INPUT, steps: [{ wait: 1 }] });
      expect(result.ok).toBe(true);
      expect(result.steps).toHaveLength(1);
    });
  });
});
