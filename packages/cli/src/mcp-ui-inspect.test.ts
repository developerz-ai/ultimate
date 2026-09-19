import { describe, expect, test } from 'bun:test';
import type { DevHost, UiInspectInput, UiInspectResult } from '@ultimat3/mcp';
import { devTools, UI_INSPECT_LIMITS } from '@ultimat3/mcp';
import { fakeBrowser } from '@ultimat3/scraping';
import { uiCapabilities } from './mcp-ui';
import { capInspect } from './mcp-ui-inspect';
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
const PAGE =
  '<!doctype html><html data-theme="dark"><head><title>Dash</title></head><body>' +
  '<h1 class="title">Hello</h1><div data-x-island="i1" data-x-hydrate="idle"></div></body></html>';

const MATCH = {
  tag: 'h1',
  text: 'Hello',
  box: { x: 8, y: 8, width: 300, height: 37 },
  visible: true,
  attrs: { class: 'title' },
  styles: { color: 'rgb(255, 255, 255)' },
};

const INPUT: UiInspectInput = {
  route: '/dash',
  viewport: { width: 390, height: 844 },
  colorScheme: 'dark',
  selectors: ['h1', ':::nope'],
  styles: ['color'],
  a11y: false,
  activeElement: true,
};

/** What the page answers for `INPUT`'s spec, recorded under the exact expression string. */
const ANSWER = JSON.stringify({
  title: 'Dash',
  theme: 'dark',
  activeElement: { tag: 'body', id: '', role: '', name: '' },
  selectors: [
    { selector: 'h1', valid: true, count: 1, truncated: false, matches: [MATCH] },
    { selector: ':::nope', valid: false, count: 0, truncated: false, matches: [] },
  ],
});

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  // No `node:` import for a scratch directory: Bun's shell makes and removes it.
  const root = `${process.env['TMPDIR'] ?? '/tmp'}/ui-inspect-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  try {
    return await run(root);
  } finally {
    await Bun.$`rm -rf ${root}`.quiet();
  }
}

const ui = (root: string, evaluate: Readonly<Record<string, string>>) =>
  uiCapabilities({
    root,
    env: {},
    boot: async () => ({ url: SERVER_URL, origin: 'booted', stop: async () => undefined }),
    driver: async () => fakeBrowser([{ url: `${SERVER_URL}/dash`, html: PAGE, evaluate }]),
    routes: () => [{ path: '/dash', file: 'apps/web/app/dash/page.tsx', budgetJs: '10kb' }],
  });

describe('unit · ui.inspect reads the page through the same navigation ui.shot photographs', () => {
  test('per-selector shape: a match with its styles, an unparsable selector as valid:false', async () => {
    await withRoot(async (root) => {
      const spec = { selectors: INPUT.selectors, styles: INPUT.styles, activeElement: true };
      const result = await ui(root, {
        [ISLAND_PROBE]: CLEAN,
        [inspectExpression(spec)]: ANSWER,
      }).inspectRoute(INPUT);
      expect(result.ok).toBe(true);
      expect(result.title).toBe('Dash');
      expect(result.theme).toBe('dark');
      expect(result.activeElement).toEqual({ tag: 'body', id: '', role: '', name: '' });
      expect(result.islands).toEqual({ declared: 1, booted: 1, mounted: 1, failed: 0 });
      expect(result.consoleErrors).toEqual([]);
      expect(result.pageErrors).toEqual([]);
      expect(result.selectors).toEqual([
        { selector: 'h1', valid: true, count: 1, truncated: false, matches: [MATCH] },
        { selector: ':::nope', valid: false, count: 0, truncated: false, matches: [] },
      ]);
      expect(result.truncated).toBe(false);
      // Its own subdirectory, so an inspect never overwrites a shot of the same route and size.
      expect(result.image).toContain('390x844-dark/inspect/shot.png');
      expect(await Bun.file(result.verdictFile).exists()).toBe(true);
    });
  });

  test('a page that answers no probe is every selector unanswered, and the verdict still gates', async () => {
    await withRoot(async (root) => {
      // Nothing recorded for the inspect expression: the offline driver throws, the tool answers.
      const result = await ui(root, { [ISLAND_PROBE]: CLEAN }).inspectRoute(INPUT);
      expect(result.ok).toBe(true);
      expect(result.title).toBe('');
      expect(result.selectors.map((entry) => entry.valid)).toEqual([false, false]);
    });
  });
});

const wide = (selector: string): UiInspectResult['selectors'][number] => ({
  selector,
  valid: true,
  count: 25,
  truncated: false,
  matches: Array.from({ length: 25 }, () => ({ ...MATCH, text: 'x'.repeat(200) })),
});

const RESULT: UiInspectResult = {
  ok: true,
  route: '/dash',
  finalUrl: `${SERVER_URL}/dash`,
  title: 'Dash',
  theme: null,
  activeElement: null,
  islands: null,
  consoleErrors: [],
  pageErrors: [],
  refused: 0,
  selectors: [],
  image: '/x/shot.png',
  verdictFile: '/x/verdict.json',
  truncated: false,
  droppedStyles: [],
};

describe('unit · the 64 KB wire cap drops matches from the last selectors first', () => {
  test('under the cap nothing changes', () => {
    const small = { ...RESULT, selectors: [wide('a')] };
    expect(capInspect(small)).toEqual(small);
  });

  test('over the cap the last selectors lose their matches, keep their count, and say so', () => {
    const big = { ...RESULT, selectors: Array.from({ length: 20 }, (_, i) => wide(`s${i}`)) };
    const capped = capInspect(big);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(
      UI_INSPECT_LIMITS.bytes,
    );
    expect(capped.truncated).toBe(true);
    // The first selector is the one the agent cared about most; it is the last to be emptied.
    expect(capped.selectors[0]?.matches).toHaveLength(25);
    const last = capped.selectors[19];
    expect(last?.matches).toEqual([]);
    expect(last?.truncated).toBe(true);
    expect(last?.count).toBe(25);
  });
});

/** A host whose `inspectRoute` records what the handler asked for and answers the minimum. */
function recordingHost(): { host: DevHost; asked: UiInspectInput[] } {
  const asked: UiInspectInput[] = [];
  const refuse = () => {
    throw new TypeError('not part of this fixture');
  };
  const host = {
    database: { label: 'app_branch_x', branch: 'x', production: false },
    routes: refuse,
    entities: refuse,
    actions: refuse,
    queries: refuse,
    policies: refuse,
    jobs: refuse,
    jobInspect: refuse,
    runQuery: refuse,
    runMigrations: refuse,
    queueDepth: refuse,
    runTests: refuse,
    tailLogs: refuse,
    readManifest: refuse,
    explainError: refuse,
    verify: refuse,
    shotRoute: refuse,
    shotIsland: refuse,
    async inspectRoute(input: UiInspectInput): Promise<UiInspectResult> {
      asked.push(input);
      return { ...RESULT, selectors: input.selectors.map((selector) => wide(selector)) };
    },
  } as unknown as DevHost;
  return { host, asked };
}

const caller = {
  actor: { kind: 'agent', id: 'a1' },
  scopes: new Set(['dev:test']),
} as unknown as Parameters<ReturnType<typeof devTools>[number]['handle']>[1];

describe('unit · the ui.inspect handler bounds what the schema cannot', () => {
  test('21 selectors are trimmed to 20, and the answer says truncated: true', async () => {
    const { host, asked } = recordingHost();
    const tool = devTools(host).find((t) => t.name === 'ui.inspect');
    if (tool === undefined) expect.unreachable('no ui.inspect tool');
    const selectors = Array.from({ length: 21 }, (_, i) => `#s${i}`);
    const result = await tool.handle({ route: '/dash', selectors }, caller);
    const first = result.content[0];
    const answer = JSON.parse(first?.type === 'text' ? first.text : '{}') as UiInspectResult;
    expect(asked[0]?.selectors).toHaveLength(UI_INSPECT_LIMITS.selectors);
    expect(answer.truncated).toBe(true);
    expect(answer.selectors).toHaveLength(20);
  });

  test('style names that are not kebab-case CSS properties are dropped by name', async () => {
    const { host, asked } = recordingHost();
    const tool = devTools(host).find((t) => t.name === 'ui.inspect');
    if (tool === undefined) expect.unreachable('no ui.inspect tool');
    const result = await tool.handle(
      { route: '/dash', selectors: ['h1'], styles: ['color', 'fontSize', 'font-size', '--x'] },
      caller,
    );
    const first = result.content[0];
    const answer = JSON.parse(first?.type === 'text' ? first.text : '{}') as UiInspectResult;
    expect(asked[0]?.styles).toEqual(['color', 'font-size']);
    expect(answer.droppedStyles).toEqual(['fontSize', '--x']);
    // Nothing was trimmed, so nothing claims it was.
    expect(answer.truncated).toBe(false);
    expect(asked[0]?.a11y).toBe(false);
    expect(asked[0]?.activeElement).toBe(true);
  });
});
