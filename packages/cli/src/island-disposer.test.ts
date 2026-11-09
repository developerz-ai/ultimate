// An island's `mount` must hand back its disposer: one typed `void`, or one whose own body returns
// nothing, is `X_ISLAND_DISPOSER_MISSING`; a returned `render(...)`, an annotated non-void return
// and a `return` nested only in an inner function are told apart.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no API for creating or removing a temporary directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path joiner.
import { join } from 'node:path';
import { appBoundaryFindings } from './boundary-findings';
import { islandDisposerFindings } from './island-disposer';

const ISLAND = 'apps/web/app/feed/feed.island.tsx';
const at = (source: string, path = ISLAND) =>
  islandDisposerFindings([{ path, source }]).map((finding) => finding.at);

describe('unit · an island mount that returns nothing is refused', () => {
  test('`mount(...): void` is a finding naming the file, and its fix shows the return', () => {
    const [finding] = islandDisposerFindings([
      {
        path: ISLAND,
        source:
          'export function mount(el: HTMLElement, props: P): void {\n  render(() => <Feed {...props} />, el);\n}\n',
      },
    ]);
    expect(finding?.code).toBe('X_ISLAND_DISPOSER_MISSING');
    expect(finding?.at).toBe(ISLAND);
    expect(finding?.fix).toStartWith('x verify --only boundaries --json');
    expect(finding?.fix).toContain('return render(() =>');
    expect(finding?.fix).toContain(ISLAND);
  });

  test('`Promise<void>` and an async mount with no annotation that returns nothing are refused', () => {
    expect(at('export async function mount(el, props): Promise<void> { await go(); }')).toEqual([
      ISLAND,
    ]);
    expect(at('export async function mount(el, props) { await go(); render(f, el); }')).toEqual([
      ISLAND,
    ]);
  });

  test("a return only inside the component callback is not the mount's own", () => {
    const source = [
      'export function mount(el: HTMLElement, props: P) {',
      '  el.textContent = "";',
      '  render(() => { const x = 1; return <Feed x={x} />; }, el);',
      '  window.addEventListener("keydown", function onKey(e) { return e; });',
      '  if (props.ok) { return; }',
      '}',
    ].join('\n');
    expect(at(source)).toEqual([ISLAND]);
  });

  test('an arrow mount with a block body that returns nothing is refused', () => {
    expect(
      at('export const mount = (el: HTMLElement, props: P) => {\n  render(f, el);\n};'),
    ).toEqual([ISLAND]);
  });
});

describe('unit · a mount that hands back its disposer passes', () => {
  test('`return render(...)` with and without an annotation', () => {
    expect(
      at(
        'export function mount(el: HTMLElement, props: P): () => void {\n  el.textContent = "";\n  return render(() => <Feed {...props} />, el);\n}',
      ),
    ).toEqual([]);
    expect(
      at(
        'export function mount(el, props) {\n  if (x) { return render(a, el); }\n  return render(b, el);\n}',
      ),
    ).toEqual([]);
  });

  test('an expression-bodied arrow and a non-void annotation are trusted', () => {
    expect(at('export const mount = (el: HTMLElement, p: P) => render(() => <F />, el);')).toEqual(
      [],
    );
    expect(
      at('export function mount(el, p): Dispose { const d = render(f, el); return d; }'),
    ).toEqual([]);
  });

  test('a mount inside a comment or a string is not a declaration, and a non-island is not read', () => {
    expect(
      at('// export function mount(el): void {}\nconst s = "function mount(el): void {}";'),
    ).toEqual([]);
    expect(
      at('export function mount(el): void { render(f, el); }', 'apps/web/app/feed/page.tsx'),
    ).toEqual([]);
  });
});

const root = mkdtempSync(join(tmpdir(), 'x-island-disposer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the boundaries step reports it from the same read', async () => {
  const found = await appBoundaryFindings(root, [
    { path: ISLAND, source: 'export function mount(el: HTMLElement): void { render(f, el); }' },
  ]);
  expect(found.map((finding) => [finding.code, finding.at])).toContainEqual([
    'X_ISLAND_DISPOSER_MISSING',
    ISLAND,
  ]);
});
