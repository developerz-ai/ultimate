// The rider over a real page tree: a form posting to an action with no `native` is the finding, one
// that declares it is not, and an app that did not load answers nothing (its load findings do). On
// `main` the finding rides as a warning line — code, file:line and fix — never a red step.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent: `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { AnyAction } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { nativeFormFindings, nativeFormWarnings } from './verify-native-form';

const declare = (name: string, native: boolean): AnyAction =>
  action({
    input: t.object({}),
    output: t.object({ id: t.string }),
    policy: allow(),
    ...(native ? { native: { success: () => '/done' } } : {}),
    handle: () => ({ id: 'x' }),
  }).named(name);

const loaded = async () => ({ findings: [] });

async function withPage(source: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'x-native-form-'));
  try {
    await Bun.write(join(root, 'apps/web/app/posts/new/page.tsx'), source);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PAGE = [
  "const CREATE = derivePath('createPost').path;",
  '<form method="post" action={CREATE}></form>',
].join('\n');

describe('nativeFormFindings', () => {
  test('a form posting to an action with no native is X_NATIVE_FORM_UNANSWERED', async () => {
    await withPage(PAGE, async (root) => {
      const findings = await nativeFormFindings(root, loaded, () => [declare('createPost', false)]);
      expect(findings.map((f) => [f.code, f.at])).toEqual([
        ['X_NATIVE_FORM_UNANSWERED', 'apps/web/app/posts/new/page.tsx'],
      ]);
      expect(findings[0]?.cause).toContain('page.tsx:2');
    });
  });

  test('an action that declares native is answered', async () => {
    await withPage(PAGE, async (root) => {
      expect(await nativeFormFindings(root, loaded, () => [declare('createPost', true)])).toEqual(
        [],
      );
    });
  });

  test('matched by path too: a literal action URL is the action that serves it', async () => {
    const page = `<form method="post" action="${declare('deletePost', false).describe().path}">`;
    await withPage(page, async (root) => {
      const findings = await nativeFormFindings(root, loaded, () => [declare('deletePost', false)]);
      expect(findings).toHaveLength(1);
    });
  });

  test('an app that did not load is the load finding, not this one', async () => {
    await withPage(PAGE, async (root) => {
      const broken = async () => ({
        findings: [{ code: 'X_APP_LOAD_FAILED', cause: 'a fixture', fix: 'nothing: a fixture' }],
      });
      expect(await nativeFormFindings(root, broken, () => [declare('createPost', false)])).toEqual(
        [],
      );
    });
  });
});

describe('nativeFormWarnings', () => {
  test('one line per unanswered form: the code, the page and line, the fix', async () => {
    await withPage(PAGE, async (root) => {
      const warnings = await nativeFormWarnings(root, loaded, () => [declare('createPost', false)]);
      expect(warnings).toHaveLength(1);
      const [line] = warnings;
      expect(line).toStartWith('X_NATIVE_FORM_UNANSWERED apps/web/app/posts/new/page.tsx:2');
      expect(line).toContain("fix: native: { success: (output) => '/where-it-lands' }");
    });
  });

  test('an answered form warns about nothing', async () => {
    await withPage(PAGE, async (root) => {
      expect(await nativeFormWarnings(root, loaded, () => [declare('createPost', true)])).toEqual(
        [],
      );
    });
  });
});
