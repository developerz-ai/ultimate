// The `island-mount-clears` guard as `x new` emits it, run through the gate's own seam: an island
// that clears its server markup outside `mountOver` is refused at the clear; one that mounts over
// it, a comment, a string and a test are not. The emitted islands themselves are the silent case.

import { describe, expect, test } from 'bun:test';
import { islandFiles } from './island';
import { names } from './naming';
import { formIslandFiles } from './resource-form-island';
import { scaffoldGuardFiles, shippedGuardFiles } from './scaffold-guards';
import { shellFiles } from './scaffold-shell';
import { shippedGuardFindings } from './shipped-guard-fixture';

const ISLAND = 'apps/web/app/posts/like.island.tsx';

/** The mount every scaffold wrote before `mountOver`: what an existing app's islands look like. */
const CLEARING_MOUNT = [
  "import { render } from 'solid-js/web';",
  'export function mount(el: HTMLElement): () => void {',
  "  el.textContent = '';",
  '  return render(() => <Like />, el);',
  '}',
  '',
].join('\n');

describe('unit · shipped guard · island-mount-clears', () => {
  test('a mount that clears the shell is X_ISLAND_MOUNT_CLEARS at the clear, with a pasteable fix', async () => {
    const findings = await shippedGuardFindings('island-mount-clears', {
      [ISLAND]: CLEARING_MOUNT,
      'packages/ui/src/menu.island.tsx':
        'export const mount = (el) => {\n  el.innerHTML = "";\n};\n',
      'apps/web/app/feed/feed.island.tsx': 'export const mount = (el) => el.replaceChildren();\n',
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_ISLAND_MOUNT_CLEARS', 'apps/web/app/feed/feed.island.tsx:1'],
      ['X_ISLAND_MOUNT_CLEARS', `${ISLAND}:3`],
      ['X_ISLAND_MOUNT_CLEARS', 'packages/ui/src/menu.island.tsx:2'],
    ]);
    expect(findings[1]?.fix).toContain(
      "adding mountOver to the island's imports from '@ultimat3/render/client'",
    );
    expect(findings[1]?.fix).toContain('return mountOver(el, (root) => render(');
  });

  test('mountOver, a comment, a string, a non-empty write and a test are silent', async () => {
    const findings = await shippedGuardFindings('island-mount-clears', {
      [ISLAND]: [
        "import { mountOver } from '@ultimat3/render/client';",
        "// el.textContent = '' is what mountOver does for us",
        'const note = "el.textContent = \'\'";',
        'export const mount = (el) => mountOver(el, (root) => render(() => <Like />, root));',
        '',
      ].join('\n'),
      'apps/web/app/posts/count.island.tsx':
        "export const mount = (el) => {\n  el.textContent = 'ready';\n  return () => {};\n};\n",
      // Once the mount is `mountOver`, a clear elsewhere — a list a handler empties — is the island's.
      'apps/web/app/posts/list.island.tsx': [
        'export const mount = (el) => mountOver(el, (root) => render(() => <List />, root));',
        "export const reset = (list) => { list.textContent = ''; };",
        '',
      ].join('\n'),
      'apps/web/app/posts/like.island.test.tsx': CLEARING_MOUNT,
      'apps/web/app/posts/helper.tsx': CLEARING_MOUNT,
    });
    expect(findings).toEqual([]);
  });

  test("a clear of an element inside the wrapper is the island's, never its mount's", async () => {
    // The reference app's `summary.island.tsx`: no Solid, a handler that empties an output region.
    const findings = await shippedGuardFindings('island-mount-clears', {
      [ISLAND]: [
        'export function mount(el: HTMLElement): () => void {',
        "  const output = el.querySelector('output');",
        "  el.addEventListener('click', () => { output.textContent = ''; });",
        '  return () => {};',
        '}',
        '',
      ].join('\n'),
      'apps/web/app/posts/list.island.tsx':
        'export const mount = (root) => {\n  root.replaceChildren();\n};\n',
    });
    expect(findings.map((finding) => finding.at)).toEqual(['apps/web/app/posts/list.island.tsx:2']);
  });

  test('every island a generator emits passes it', async () => {
    const emitted = [
      ...islandFiles('counter', { dir: 'apps/web/app/counter' }),
      ...formIslandFiles(names('invoice'), 'apps/web/app/invoice', 'apps/web/app/invoices'),
      ...shellFiles(names('acme'), true),
    ].filter((file) => file.path.endsWith('.island.tsx'));
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    const files = Object.fromEntries(emitted.map((file) => [file.path, String(file.contents)]));
    expect(await shippedGuardFindings('island-mount-clears', files)).toEqual([]);
  });

  test('x new writes it, with its own test', () => {
    const paths = scaffoldGuardFiles().map((file) => file.path);
    expect(paths).toContain('guards/island-mount-clears.ts');
    expect(shippedGuardFiles('island-mount-clears')?.map((file) => file.path)).toEqual([
      'guards/island-mount-clears.ts',
      'guards/island-mount-clears.test.ts',
    ]);
  });
});
