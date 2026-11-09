// The four `ui.*` tools as a model calls them, against a recording host: what each handler hands
// the browser half (viewport, theme, the bounded inspect spec), which scope each sits under, and
// that a failing verdict comes back as an `isError` result rather than a quiet success.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import {
  inspectSpecOf,
  UI_DIFF_DEFAULT_THRESHOLD,
  UI_INSPECT_LIMITS,
  UI_VIEWPORTS,
  type UiDiffInput,
  type UiHost,
  type UiInspectInput,
  type UiInspectResult,
  type UiIslandInput,
  type UiShotInput,
  uiTools,
  viewportOf,
} from './dev-ui-tools';
import type { AnyMcpTool, McpCaller } from './registry';

const caller: McpCaller = { actor: agentActor({ id: 'dev' }), scopes: new Set(['dev:test']) };

function recordingHost(ok: boolean) {
  const seen: {
    shot?: UiShotInput;
    island?: UiIslandInput;
    inspect?: UiInspectInput;
    diff?: UiDiffInput;
  } = {};
  const inspected = (input: UiInspectInput): UiInspectResult => ({
    ok,
    route: input.route,
    finalUrl: `http://localhost${input.route}`,
    title: 't',
    theme: null,
    activeElement: null,
    islands: null,
    consoleErrors: [],
    pageErrors: [],
    refused: 0,
    selectors: [],
    image: 'p.png',
    verdictFile: 'v.json',
    truncated: false,
    droppedStyles: [],
  });
  const host: UiHost = {
    shotRoute(input) {
      seen.shot = input;
      return Promise.resolve({ ok, image: 'p.png', verdictFile: 'v.json', verdict: {} });
    },
    shotIsland(input) {
      seen.island = input;
      return Promise.resolve({ ok, dir: 'd', verdictFile: 'v.json', verdict: {} });
    },
    inspectRoute(input) {
      seen.inspect = input;
      return Promise.resolve(inspected(input));
    },
    diffShots(input) {
      seen.diff = input;
      return Promise.resolve({
        ok: true,
        before: input.before,
        after: input.after,
        width: 1,
        height: 1,
        changedPixels: 0,
        changedPercent: 0,
        changedBox: null,
        diff: 'diff.png',
      });
    },
  };
  return { host, seen };
}

const toolNamed = (tools: readonly AnyMcpTool[], name: string): AnyMcpTool => {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) return expect.unreachable(`no ${name} tool`);
  return found;
};

const textOf = (result: { readonly content: readonly unknown[] }): unknown => {
  const first = result.content[0] as { readonly text?: string } | undefined;
  return JSON.parse(first?.text ?? 'null') as unknown;
};

describe('viewportOf()', () => {
  test('a full explicit size wins; a half one falls back to the name, then to desktop', () => {
    expect(viewportOf({ width: 500, height: 700, viewport: 'phone' })).toEqual({
      width: 500,
      height: 700,
    });
    expect(viewportOf({ width: 500, viewport: 'phone' })).toEqual(UI_VIEWPORTS.phone);
    expect(viewportOf({})).toEqual(UI_VIEWPORTS.desktop);
    // An inherited key is not a viewport name.
    expect(viewportOf({ viewport: 'constructor' })).toEqual(UI_VIEWPORTS.desktop);
  });
});

describe('inspectSpecOf()', () => {
  test('selectors past the cap are trimmed and confessed; bad style names are named', () => {
    const selectors = Array.from({ length: UI_INSPECT_LIMITS.selectors + 3 }, (_, i) => `#s${i}`);
    const read = inspectSpecOf({ selectors, styles: ['color', 'fontSize', 7, 'font-size'] });
    expect(read.spec.selectors).toHaveLength(UI_INSPECT_LIMITS.selectors);
    expect(read.trimmed).toBe(true);
    expect(read.spec.styles).toEqual(['color', 'font-size']);
    expect(read.droppedStyles).toEqual(['fontSize']);
    expect(read.spec.a11y).toBe(false);
    expect(read.spec.activeElement).toBe(true);
  });
});

describe('uiTools()', () => {
  test('the three browser tools sit under the test scope; ui.diff under read', () => {
    const tools = uiTools(recordingHost(true).host, { test: 'dev:test', read: 'dev:read' });
    expect(tools.map((tool) => [tool.name, tool.scope, tool.destructive])).toEqual([
      ['ui.shot', 'dev:test', true],
      ['ui.island', 'dev:test', true],
      ['ui.inspect', 'dev:test', true],
      ['ui.diff', 'dev:read', false],
    ]);
  });

  test('ui.shot hands the host the viewport and theme the model asked for', async () => {
    const { host, seen } = recordingHost(true);
    const shot = toolNamed(uiTools(host, { test: 't', read: 'r' }), 'ui.shot');
    const result = await shot.handle(
      { route: '/dash', viewport: 'tablet', theme: 'light', fullPage: false },
      caller,
    );
    expect(seen.shot).toEqual({
      route: '/dash',
      viewport: UI_VIEWPORTS.tablet,
      colorScheme: 'light',
      fullPage: false,
    });
    expect(result.isError).toBeUndefined();
  });

  test('a failing verdict is an isError result, never a quiet success', async () => {
    const { host } = recordingHost(false);
    const tools = uiTools(host, { test: 't', read: 'r' });
    for (const [name, args] of [
      ['ui.shot', { route: '/' }],
      ['ui.island', { island: 'links-table' }],
      ['ui.inspect', { route: '/', selectors: ['h1'] }],
    ] as const) {
      expect((await toolNamed(tools, name).handle(args, caller)).isError).toBe(true);
    }
  });

  test('ui.island passes one state only when one was named', async () => {
    const { host, seen } = recordingHost(true);
    const island = toolNamed(uiTools(host, { test: 't', read: 'r' }), 'ui.island');
    await island.handle({ island: 'links-table' }, caller);
    expect(seen.island).toEqual({ island: 'links-table' });
    await island.handle({ island: 'links-table', state: 'empty' }, caller);
    expect(seen.island).toEqual({ island: 'links-table', state: 'empty' });
  });

  test('ui.inspect reports a trim the host never saw', async () => {
    const { host, seen } = recordingHost(true);
    const inspect = toolNamed(uiTools(host, { test: 't', read: 'r' }), 'ui.inspect');
    const selectors = Array.from({ length: UI_INSPECT_LIMITS.selectors + 1 }, (_, i) => `#s${i}`);
    const result = await inspect.handle(
      { route: '/', selectors, styles: ['Bad'], theme: 'dark' },
      caller,
    );
    expect(seen.inspect?.selectors).toHaveLength(UI_INSPECT_LIMITS.selectors);
    expect(seen.inspect?.colorScheme).toBe('dark');
    expect(textOf(result)).toMatchObject({ truncated: true, droppedStyles: ['Bad'] });
  });

  test('ui.diff defaults its threshold and passes out only when given', async () => {
    const { host, seen } = recordingHost(true);
    const diff = toolNamed(uiTools(host, { test: 't', read: 'r' }), 'ui.diff');
    await diff.handle({ before: '.x/shot/a.png', after: '.x/shot/b.png' }, caller);
    expect(seen.diff).toEqual({
      before: '.x/shot/a.png',
      after: '.x/shot/b.png',
      threshold: UI_DIFF_DEFAULT_THRESHOLD,
    });
    await diff.handle({ before: 'a', after: 'b', threshold: 0.5, out: '.x/shot/d.png' }, caller);
    expect(seen.diff).toMatchObject({ threshold: 0.5, out: '.x/shot/d.png' });
  });
});
