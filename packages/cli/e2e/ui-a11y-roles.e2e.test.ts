// The roles the rendered audit deferred (2026/11/11 slice 15 T3), read off CHROME's own
// accessibility tree over the catalog components that carry them: every listbox, option, menuitem
// and treeitem has a name, and it is its own (a tree branch is not named by its children, an
// option not by its description); a Table's scroll stop is a region named by its caption; and Tab
// from an open Menu closes it with focus back on its trigger. Skips with no Chrome, unless
// E2E_BROWSER_REQUIRED=1. Command: bun test ./packages/cli/e2e/ui-a11y-roles.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { AxTreeNode, E2eBrowser } from '@ultimat3/testing';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_OPEN_MS,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/roles.island.tsx';

const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { Field, Menu, SearchableSelect, setSolidRuntime, Table, Tree, UiProvider } from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const [open, setOpen] = createSignal(false);
    render(
    () => (
      <UiProvider locale="en">
        <Table caption="Rows"><tbody><tr><td>one</td></tr></tbody></Table>
        <Tree
          label="Files"
          open={['src']}
          onSelect={() => {}}
          onExpand={() => new Promise(() => {})}
          nodes={[
            { id: 'src', label: 'src', children: [{ id: 'a', label: 'a.ts' }, { id: 'b', label: 'b.ts' }] },
            { id: 'vendor', label: 'vendor', lazy: true },
          ]}
        />
        <Field label="Time zone">
          {(control) => (
            <SearchableSelect
              name="tz"
              id={control.id}
              options={[
                { value: 'utc', label: 'UTC', description: 'Coordinated Universal Time' },
                { value: 'cet', label: 'CET' },
              ]}
            />
          )}
        </Field>
        <Menu
          label="Actions"
          open={open()}
          onOpenChange={setOpen}
          trigger={(control) => (
            <button type="button" id="trigger" aria-haspopup={control['aria-haspopup']}
              aria-expanded={control['aria-expanded']} aria-controls={control['aria-controls']}
              onClick={() => setOpen(!open())}>More</button>
          )}
          items={[
            { id: 'edit', label: 'Edit', onSelect: () => {} },
            { id: 'delete', label: 'Delete', onSelect: () => {} },
          ]}
        />
        <button type="button" id="after">After</button>
      </UiProvider>
    ),
    el,
  );
}
`;

const documentFor = (url: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>roles</title><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/**
 * Expands the lazy branch (its fetch never settles, so it shows its loading text), then opens the
 * listbox the way a keyboard does: focus on the field, ArrowDown.
 */
const OPEN_LISTBOX = `(async () => {
  document.querySelector('[data-tree-id="vendor"]').click();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const field = document.querySelector('[role="combobox"]');
  field.focus();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return JSON.stringify(window.__errors);
})()`;

/** Opens the menu from its focused trigger — focus moves into the menu, so the listbox closes. */
const OPEN_MENU = `(async () => {
  const trigger = document.getElementById('trigger');
  trigger.focus();
  trigger.click();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return JSON.stringify(window.__errors);
})()`;

/** The roles whose node needs a name of its own — the ones the audit deferred. */
const DEFERRED = new Set([
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 4 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)('deferred a11y roles in Chrome', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: E2eBrowser | undefined;
  let base = '';

  const page = () => browser?.page ?? expect.unreachable('no browser');
  const open = async (expression: string): Promise<readonly AxTreeNode[]> => {
    await page().goto(base);
    await page().waitFor('window.__done === true', 'the island to mount', MOUNT_MS);
    expect(JSON.parse(String(await page().evaluate(expression)))).toEqual([]);
    const tree = await page().accessibilityTree({ describe: () => false, selectors: [] });
    return tree.filter((node) => !node.ignored);
  };
  const named = (tree: readonly AxTreeNode[], role: string): string[] =>
    tree.filter((node) => node.role === role).map((node) => node.name);

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-a11y-roles', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const asset = bundle.assetAt(new URL(request.url).pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        return new Response(documentFor(chunk.url), { headers: { 'content-type': 'text/html' } });
      },
    });
    base = `http://localhost:${String(server.port)}/`;
    browser = await (required ? openE2eBrowser() : openE2eBrowserIfAvailable());
    if (browser === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test(
    'every listbox, option, menuitem and treeitem in the tree has a non-blank name',
    async () => {
      const tree = [...(await open(OPEN_LISTBOX)), ...(await open(OPEN_MENU))];
      const roles = new Set(tree.map((node) => node.role));
      expect([...DEFERRED].filter((role) => roles.has(role)).sort()).toEqual([
        'listbox',
        'menuitem',
        'option',
        'treeitem',
      ]);
      const blank = tree.filter((node) => DEFERRED.has(node.role) && node.name.trim() === '');
      expect(blank.map((node) => node.role)).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'each name is the node’s own: a loading branch not named by its status, an option not by its note',
    async () => {
      const tree = await open(OPEN_LISTBOX);
      expect(named(tree, 'treeitem').sort()).toEqual(['a.ts', 'b.ts', 'src', 'vendor']);
      expect(named(tree, 'listbox')).toEqual(['Time zone']);
      expect(named(tree, 'option')).toEqual(['UTC', 'CET']);
      const utc = tree.find((node) => node.role === 'option' && node.name === 'UTC');
      expect(utc?.description).toBe('Coordinated Universal Time');
      expect(named(await open(OPEN_MENU), 'menuitem')).toEqual(['Edit', 'Delete']);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'the Table’s scroll stop is a region named by its caption, not a nameless box',
    async () => {
      const tree = await open(OPEN_LISTBOX);
      expect(named(tree, 'region')).toContain('Rows');
      expect(tree.filter((node) => node.role === 'generic' && node.focused === true)).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  // Escape too: the trigger was rebuilt on every open, so the node focus went back to was gone.
  for (const key of ['Tab', 'Escape'] as const) {
    test(
      `${key} from an open menu closes it and hands focus back to its trigger`,
      async () => {
        await open(OPEN_MENU);
        const after = JSON.parse(
          String(
            await page().evaluate(`(async () => {
            const item = document.querySelector('[role="menuitem"]');
            item.focus();
            item.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            return JSON.stringify({
              menu: document.querySelector('[role="menu"]') !== null,
              focus: document.activeElement && document.activeElement.id,
            });
          })()`),
          ),
        ) as { menu: boolean; focus: string };
        expect(after).toEqual({ menu: false, focus: 'trigger' });
      },
      HOOK_TIMEOUT_MS,
    );
  }
});
