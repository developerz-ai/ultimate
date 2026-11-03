#!/usr/bin/env bun
// `@ultimat3/cli`'s `prepack` and `postpack`: the wiki pages `x docs` answers from, copied into
// the CLI package's own `wiki/` directory for the tarball and removed after it. Never committed (`.gitignore`): the
// checkout's `wiki/` is the one copy, and the CLI reads it in place there (`docs-sources.ts`).
//
//   bun run scripts/pack-cli-wiki.ts [--clean] [--json]

// why: Bun has no directory listing, mkdir or recursive remove; a pack hook copies synchronously.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'pack-cli-wiki';

/**
 * Every page but `Error-Codes.md` — `x errors explain` is the one way to a code, and its 479 kB
 * would be the largest page in the tarball for an index that skips it — and GitHub's `_Sidebar`
 * and `_Footer` chrome, which is navigation, not prose.
 */
export function shippedPages(files: readonly string[]): readonly string[] {
  return files
    .filter((file) => file.endsWith('.md') && !file.startsWith('_') && file !== 'Error-Codes.md')
    .sort();
}

/** The pages copied, or a finding when there is nothing to copy: a tarball without its wiki. */
export function packWiki(root: string): {
  readonly pages: readonly string[];
  readonly finding?: Finding;
} {
  const from = join(root, 'wiki');
  const to = join(root, 'packages', 'cli', 'wiki');
  let files: readonly string[] = [];
  try {
    files = readdirSync(from);
  } catch {
    // Fall through: no directory is no pages, refused below.
  }
  const pages = shippedPages(files);
  if (!pages.includes('Home.md')) {
    return {
      pages: [],
      finding: {
        code: 'X_PACKAGE_SHAPE',
        cause: `wiki/Home.md is not in this checkout, so @ultimat3/cli would publish without the wiki x docs reads`,
        fix: 'git checkout -- wiki && bun run scripts/pack-cli-wiki.ts --json',
        at: 'wiki/',
      },
    };
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const page of pages) copyFileSync(join(from, page), join(to, page));
  return { pages };
}

export function cleanWiki(root: string): void {
  rmSync(join(root, 'packages', 'cli', 'wiki'), { recursive: true, force: true });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const json = flagBool(args, 'json');
  const root = repoRoot();
  if (flagBool(args, 'clean')) {
    cleanWiki(root);
    report({ ok: true, script: SCRIPT, summary: 'packages/cli/wiki removed' }, json);
  }
  const { pages, finding } = packWiki(root);
  report(
    {
      ok: finding === undefined,
      script: SCRIPT,
      summary:
        finding === undefined
          ? `${pages.length} wiki pages copied into packages/cli/wiki`
          : 'no wiki to ship',
      findings: finding === undefined ? [] : [finding],
      data: { pages },
    },
    json,
  );
}
