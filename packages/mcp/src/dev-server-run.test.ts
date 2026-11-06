// `devTools` — the tools that execute something (tests, verify, logs) and the ui tools that
// photograph through the host: each an error exactly when its verdict is not ok.

import { describe, expect, test } from 'bun:test';
import { DEV_SCOPES, devTools, UI_VIEWPORTS, viewportOf } from './dev-server';
import { BRANCH, caller, fakeHost, textOf } from './dev-server-fixture';

describe('the tools that execute something report failure as isError', () => {
  test('tests.run marks a failing run as an error, and a green run as not', async () => {
    const { host } = fakeHost(BRANCH);
    const seen: (string | undefined)[] = [];
    const tools = devTools({
      ...host,
      async runTests(filter) {
        seen.push(filter);
        return filter === 'red'
          ? {
              passed: 1,
              failed: 2,
              skipped: 0,
              durationMs: 9,
              failures: [{ test: 'a', message: 'boom' }],
            }
          : { passed: 3, failed: 0, skipped: 0, durationMs: 4, failures: [] };
      },
    });
    const runner = tools.find((t) => t.name === 'tests.run');
    if (runner === undefined) expect.unreachable('no tests.run tool');

    const red = await runner.handle({ filter: 'red' }, caller);
    expect(red.isError).toBe(true);
    const green = await runner.handle({}, caller);
    expect(green.isError).toBeUndefined();
    // A missing filter is `undefined`, never the string "undefined".
    expect(seen).toEqual(['red', undefined]);
  });

  test('verify.run is an error exactly when the gate is not ok', async () => {
    const { host } = fakeHost(BRANCH);
    const asked: boolean[] = [];
    const tools = devTools({
      ...host,
      async verify(fix) {
        asked.push(fix);
        return { ok: !fix, steps: [{ name: 'types', ok: !fix }] };
      },
    });
    const verify = tools.find((t) => t.name === 'verify.run');
    if (verify === undefined) expect.unreachable('no verify.run tool');

    expect((await verify.handle({}, caller)).isError).toBeUndefined();
    expect((await verify.handle({ fix: true }, caller)).isError).toBe(true);
    // `fix` is a boolean gate, not a truthiness one: a string must not turn autofix on.
    await verify.handle({ fix: 'yes' }, caller);
    expect(asked).toEqual([false, true, false]);
  });

  test('logs.tail defaults to 100 lines and passes a role through only when it is a string', async () => {
    const { host } = fakeHost(BRANCH);
    const asked: { lines: number; role: string | undefined }[] = [];
    const tools = devTools({
      ...host,
      async tailLogs(lines, role) {
        asked.push({ lines, role });
        return ['a', 'b'];
      },
    });
    const tail = tools.find((t) => t.name === 'logs.tail');
    if (tail === undefined) expect.unreachable('no logs.tail tool');

    const result = await tail.handle({}, caller);
    expect(textOf(result)).toBe('a\nb');
    await tail.handle({ lines: 5, role: 'worker' }, caller);
    await tail.handle({ lines: '5', role: 12 }, caller);
    expect(asked).toEqual([
      { lines: 100, role: undefined },
      { lines: 5, role: 'worker' },
      { lines: 100, role: undefined },
    ]);
  });
});

describe('the ui tools photograph through the host and never inline the picture', () => {
  test('ui.shot resolves a named viewport, defaults to desktop/dark, and passes the route through', async () => {
    const { host, ran } = fakeHost(BRANCH);
    const tools = devTools(host);
    const shot = tools.find((t) => t.name === 'ui.shot');
    if (shot === undefined) expect.unreachable('no ui.shot tool');
    expect(shot.destructive).toBe(true);
    expect(shot.scope).toBe(DEV_SCOPES.test);

    const result = await shot.handle({ route: '/dashboard' }, caller);
    expect(ran).toContain('shot:/dashboard:1440x900:dark');
    // The answer names files; it carries no image bytes.
    const answer = JSON.parse(textOf(result) ?? '{}') as { image: string };
    expect(answer.image).toBe('/x/shot.png');
    expect(textOf(result)).not.toContain('base64');

    await shot.handle({ route: '/', viewport: 'phone', theme: 'light' }, caller);
    expect(ran).toContain('shot:/:390x844:light');
  });

  test('an explicit width AND height beat the name; half a pair does not', () => {
    expect(viewportOf({ width: 1024, height: 600, viewport: 'phone' })).toEqual({
      width: 1024,
      height: 600,
    });
    expect(viewportOf({ width: 1024, viewport: 'phone' })).toEqual(UI_VIEWPORTS.phone);
    expect(viewportOf({})).toEqual(UI_VIEWPORTS.desktop);
    // A name that is not one of ours is the default, never a crash and never a 0×0 frame.
    expect(viewportOf({ viewport: 'watch' })).toEqual(UI_VIEWPORTS.desktop);
  });

  test('ui.shot and ui.island are errors exactly when the verdict is not ok', async () => {
    const { host } = fakeHost(BRANCH);
    const tools = devTools({
      ...host,
      async shotRoute() {
        return { ok: false, image: '/x/shot.png', verdictFile: '/x/v.json', verdict: {} };
      },
      async shotIsland() {
        return { ok: false, dir: '/x/i', verdictFile: '/x/i/v.json', verdict: {} };
      },
    });
    const shot = tools.find((t) => t.name === 'ui.shot');
    const island = tools.find((t) => t.name === 'ui.island');
    expect((await shot?.handle({ route: '/a' }, caller))?.isError).toBe(true);
    expect((await island?.handle({ island: 'feed' }, caller))?.isError).toBe(true);
  });

  test('ui.inspect defaults to desktop/dark, no a11y, activeElement on; errors when not ok', async () => {
    const { host, ran } = fakeHost(BRANCH);
    const inspect = devTools(host).find((t) => t.name === 'ui.inspect');
    if (inspect === undefined) expect.unreachable('no ui.inspect tool');
    expect(inspect.destructive).toBe(true);
    expect(inspect.scope).toBe(DEV_SCOPES.test);
    const result = await inspect.handle({ route: '/dash', selectors: ['h1', '.card'] }, caller);
    expect(ran).toContain('inspect:/dash:1440x900:dark:h1,.card::false:true');
    const answer = JSON.parse(textOf(result) ?? '{}') as {
      selectors: readonly { selector: string }[];
      truncated: boolean;
      droppedStyles: readonly string[];
    };
    expect(answer.selectors.map((entry) => entry.selector)).toEqual(['h1', '.card']);
    expect(answer.truncated).toBe(false);
    expect(answer.droppedStyles).toEqual([]);
    expect(result.isError).toBeUndefined();
    const explicit = { viewport: 'phone', theme: 'light', a11y: true, activeElement: false };
    await inspect.handle({ route: '/', selectors: ['a'], ...explicit }, caller);
    expect(ran).toContain('inspect:/:390x844:light:a::true:false');

    const red = devTools({
      ...host,
      async inspectRoute(input) {
        return { ...(await host.inspectRoute(input)), ok: false };
      },
    }).find((t) => t.name === 'ui.inspect');
    expect((await red?.handle({ route: '/a', selectors: ['h1'] }, caller))?.isError).toBe(true);
  });

  test('ui.island passes the state through only when it is a string', async () => {
    const { host, ran } = fakeHost(BRANCH);
    const island = devTools(host).find((t) => t.name === 'ui.island');
    await island?.handle({ island: 'feed' }, caller);
    await island?.handle({ island: 'feed', state: 'empty' }, caller);
    await island?.handle({ island: 'feed', state: 3 }, caller);
    expect(ran.filter((r) => r.startsWith('island:'))).toEqual([
      'island:feed:*',
      'island:feed:empty',
      'island:feed:*',
    ]);
  });
});
