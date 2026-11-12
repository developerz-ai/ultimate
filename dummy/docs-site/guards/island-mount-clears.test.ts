// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { islandMountClears, readsFile } from './island-mount-clears';

const file = (source: string) => [{ path: 'apps/web/app/posts/like.island.tsx', source }];

unitTest('a mount that clears its shell is refused, and the finding names the line', () => {
  const findings = islandMountClears(
    file("export function mount(el) {\n  el.textContent = '';\n}"),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_ISLAND_MOUNT_CLEARS');
  expect(findings[0]?.at).toBe('apps/web/app/posts/like.island.tsx:2');
  // Not an import line: an app's import audit would read a pasteable one as this file's own.
  expect(findings[0]?.fix).toContain("imports from '@ultimat3/render/client'");
});

unitTest('innerHTML and a bare replaceChildren() are the same clear', () => {
  expect(islandMountClears(file('el.innerHTML = "";'))).toHaveLength(1);
  expect(islandMountClears(file('el.replaceChildren();'))).toHaveLength(1);
});

unitTest('mountOver, a comment, a string and a non-empty write are not refused', () => {
  expect(
    islandMountClears(file('return mountOver(el, (root) => render(() => <A />, root));')),
  ).toEqual([]);
  expect(islandMountClears(file("// el.textContent = '';"))).toEqual([]);
  expect(islandMountClears(file('const s = "el.textContent = \'\'";'))).toEqual([]);
  expect(islandMountClears(file("el.textContent = 'ready';"))).toEqual([]);
  expect(islandMountClears(file('if (el.textContent === "") go();'))).toEqual([]);
});

unitTest('islands are read; their tests and other files are not', () => {
  expect(readsFile('apps/web/app/posts/like.island.tsx')).toBe(true);
  expect(readsFile('packages/ui/src/menu.island.tsx')).toBe(true);
  expect(readsFile('apps/web/app/posts/like.island.test.tsx')).toBe(false);
  expect(readsFile('apps/web/app/posts/page.tsx')).toBe(false);
});
