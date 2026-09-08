// The five INTERFACE guards `x new` ships, driven the way the gate drives them: written to disk,
// imported through the same `guardFindings` seam `x verify`'s `boundaries` step calls, and pointed
// at a real scaffolded tree. Its sibling `scaffold-guards.test.ts` covers the `AGENTS.md` rules.
//
// Each rule is proven TWICE — it fires on the mistake, and it stays silent on the legitimate
// lookalike. The second half is what keeps the rule switched on: a guard that reports the correct
// code beside the wrong one gets deleted by the first author who meets it.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, so `mkdtemp`/`rm` come from node:fs.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { planNewApp } from '../cmd-new';
import { guardFindings } from '../guards';
import type { Finding } from '../output';

/** One extra file on top of a real `x new` tree, then the gate's own guard pass over the result. */
async function findingsWith(files: Readonly<Record<string, string>>): Promise<readonly Finding[]> {
  const dir = mkdtempSync(join(tmpdir(), 'x-guards-ux-'));
  try {
    for (const file of planNewApp({ name: 'guard-demo', example: true })) {
      await Bun.write(join(dir, file.path), file.contents);
    }
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(dir, path), contents);
    }
    return await guardFindings(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (findings: readonly Finding[]): readonly string[] => findings.map((f) => f.code);

const page = (body: string): string =>
  ['export function Panel() {', `  return ${body};`, '}', ''].join('\n');

describe('unit · x new · the interface guards refuse the mistake they name', () => {
  test('a click handler on an inert element is X_SEMANTIC_INTERACTIVE', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.tsx': page('<div onClick={() => save()}>{label}</div>'),
    });
    expect(codes(findings)).toEqual(['X_SEMANTIC_INTERACTIVE']);
    expect(findings[0]?.fix).toContain('<button type="button">');
  }, 30_000);

  test('the native control it names is silent', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.tsx': page(
        '<button type="button" onClick={() => save()}>{label}</button>',
      ),
    });
    expect(findings).toEqual([]);
  }, 30_000);

  test('a focus ring removed and not replaced is X_FOCUS_VISIBLE', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.module.scss': '.trigger {\n  outline: none;\n}\n',
    });
    expect(codes(findings)).toEqual(['X_FOCUS_VISIBLE']);
    expect(findings[0]?.fix).toContain('focus-ring');
  }, 30_000);

  test('a nested :focus-visible that paints one back is silent', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.module.scss': [
        '.trigger {',
        '  outline: none;',
        '',
        '  &:focus-visible {',
        "    box-shadow: 0 0 0 2px tokens.role('accent');",
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  }, 30_000);

  test('an image with no box is X_IMAGE_DIMENSIONS', async () => {
    const findings = await findingsWith({
      'apps/web/site/hero/panel.tsx': page('<img src="/hero.png" alt="" />'),
    });
    expect(codes(findings)).toEqual(['X_IMAGE_DIMENSIONS']);
    expect(findings[0]?.fix).toContain('aspect-ratio');
  }, 30_000);

  test('the same image with its intrinsic size is silent', async () => {
    const findings = await findingsWith({
      'apps/web/site/hero/panel.tsx': page(
        '<img src="/hero.png" width={1200} height={630} alt="" />',
      ),
    });
    expect(findings).toEqual([]);
  }, 30_000);

  test('a transition on a layout property is X_ANIMATED_LAYOUT_PROPERTY', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.module.scss': '.panel {\n  transition: width 200ms ease;\n}\n',
    });
    expect(codes(findings)).toEqual(['X_ANIMATED_LAYOUT_PROPERTY']);
    expect(findings[0]?.fix).toContain('scaleX');
  }, 30_000);

  test('the compositor-only pair the fix names is silent', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/panel.module.scss': '.panel {\n  transition: transform 200ms ease;\n}\n',
    });
    expect(findings).toEqual([]);
  }, 30_000);

  test('an island with no states file is X_ISLAND_WITHOUT_STATES', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/extra.island.tsx': 'export const mount = (): void => {};\n',
    });
    expect(codes(findings)).toEqual(['X_ISLAND_WITHOUT_STATES']);
    expect(findings[0]?.fix).toContain('apps/web/app/post/extra.island.states.ts');
  }, 30_000);

  test('the sibling states file satisfies it', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/extra.island.tsx': 'export const mount = (): void => {};\n',
      'apps/web/app/post/extra.island.states.ts': [
        "import { defineIslandStates } from '@ultimat3/testing';",
        'export const extraStates = defineIslandStates({',
        "  island: 'apps/web/app/post/extra.island.tsx',",
        "  states: [{ id: 'idle', title: 'the first paint', props: {} }],",
        '});',
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  }, 30_000);

  // The scaffold's own island is the case that proves the loop is closed: `x g resource` writes the
  // form island AND its states file, so `x new` followed by `x verify` is green on the rule above.
  test('the island x new scaffolds already declares its states', async () => {
    const written = planNewApp({ name: 'guard-demo', example: true }).map((file) => file.path);
    expect(written).toContain('apps/web/app/post/post-form.island.tsx');
    expect(written).toContain('apps/web/app/post/post-form.island.states.ts');
  });
});
