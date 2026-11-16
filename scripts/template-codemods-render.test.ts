// What `x new` renders, as the template-codemod rule's second eye: a scaffold change made outside
// `templates/` (a constant a template prints) is a changed rendered path; the version is masked;
// a tag with no lock is a notice; a working lock that is not today's render is stale.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { loadVersion } from '../packages/cli/src/version-loader';
import {
  RENDER_LOCK_FILE,
  renderCheck,
  renderedChanges,
  renderedFiles,
  renderLockText,
} from './template-codemods-render';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lock = { 'bare:ci.yml': 'aa', 'example:ci.yml': 'aa', 'bare:README.md': 'bb' };

describe('unit · template-codemods, the rendered scaffold', () => {
  test('a path whose bytes moved in any variant, or that came or went, is one change', () => {
    expect(renderedChanges(lock, { ...lock, 'example:ci.yml': 'cc' })).toEqual(['ci.yml']);
    expect(renderedChanges(lock, { ...lock, 'bare:new.ts': 'dd' })).toEqual(['new.ts']);
    // A variant the tag never rendered (a shape added since) owes no codemod: no app is on it yet.
    expect(
      renderedChanges(lock, { ...lock, 'saas:ci.yml': 'ee', 'saas:billing.ts': 'ff' }),
    ).toEqual([]);
    expect(renderedChanges(lock, lock)).toEqual([]);
  });

  test('the release version is masked: no rendered file carries the stamp a bump moves', () => {
    const version = loadVersion();
    const files = Object.entries(renderedFiles());
    // Non-vacuity: the pins really are rendered, so the mask had something to take out.
    expect(files.some(([, text]) => text.includes('"0.0.0"'))).toBe(true);
    expect(files.filter(([, text]) => text.includes(version)).map(([key]) => key)).toEqual([]);
  });

  test('a tag with no lock is a notice; a working lock not today’s render is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-render-lock-'));
    dirs.push(root);
    const now = { 'bare:ci.yml': 'aa' };
    const none = await renderCheck({ root, tag: 'v1.0.0', show: async () => undefined, now });
    expect(none).toMatchObject({ changed: [], stale: true });
    expect(none.notice).toContain('v1.0.0');
    await Bun.write(join(root, RENDER_LOCK_FILE), renderLockText(now));
    const based = await renderCheck({
      root,
      tag: 'v1.0.0',
      show: async () => renderLockText({ 'bare:ci.yml': 'zz' }),
      now,
    });
    expect(based).toEqual({ changed: ['ci.yml'], paths: ['ci.yml'], stale: false });
  });
});
