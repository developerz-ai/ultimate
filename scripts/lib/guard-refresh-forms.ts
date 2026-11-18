#!/usr/bin/env bun
// Every rule-file text a shipped guard was ever released as, hashed: read from each release tag's
// own templates and the tree's, written to `packages/cli/src/templates/guard-released-forms.ts` so
// the `vendored-guards` codemod tells a stale but unedited copy from an app's edit.
//
//   bun run scripts/lib/guard-refresh-forms.ts [--write] [--json]

// why: Bun ships no temp-directory or recursive-remove API.
import { mkdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { guardFormHash } from '../../packages/cli/src/guards-vendored';
import {
  reportOnlyForm,
  SHIPPED_GUARD_NAMES,
} from '../../packages/cli/src/templates/scaffold-guards';
import { ENTRY, extractTemplates, gitTreeSource, SCRATCH } from './guard-refresh-archive';
import { git } from './release-due-git';
import { repoRoot } from './run';

export const FORMS_FILE = 'packages/cli/src/templates/guard-released-forms.ts';
type Forms = Record<string, Map<string, 'error' | 'warning'>>;
/** Guard name → every hash its test file was released as. */
type TestForms = Record<string, Set<string>>;

/** What a tag's `scaffold-guards.ts` exports: only `scaffoldGuardFiles` is in every release. */
interface ScaffoldGuards {
  readonly scaffoldGuardFiles: () => readonly GuardFile[];
  readonly SHIPPED_GUARD_NAMES?: readonly string[];
  readonly shippedGuardFiles?: (name: string) => readonly GuardFile[] | undefined;
  readonly shippedGuardSources?: (name: string) => readonly string[];
}

interface GuardFile {
  readonly path: string;
  readonly contents: unknown;
}

const add = (forms: Forms, name: string, text: string): void => {
  const known = forms[name] ?? new Map<string, 'error' | 'warning'>();
  known.set(guardFormHash(text), reportOnlyForm(text) ? 'warning' : 'error');
  forms[name] = known;
};

const textOf = (files: readonly GuardFile[], path: string): string | undefined => {
  const contents = files.find((file) => file.path === path)?.contents;
  return typeof contents === 'string' ? contents : undefined;
};

const collect = async (forms: Forms, tests: TestForms, module: string): Promise<void> => {
  const guards = (await import(module)) as ScaffoldGuards;
  const scaffolded = guards.scaffoldGuardFiles();
  // A guard no longer shipped has no built-in rule for its copy to give way to: it stays the app's.
  for (const name of SHIPPED_GUARD_NAMES) {
    const files = guards.shippedGuardFiles?.(name) ?? scaffolded;
    const rule = textOf(files, `guards/${name}.ts`);
    for (const text of guards.shippedGuardSources?.(name) ?? (rule === undefined ? [] : [rule])) {
      add(forms, name, text);
    }
    const test = textOf(files, `guards/${name}.test.ts`);
    if (test !== undefined) {
      const known = tests[name] ?? new Set<string>();
      known.add(guardFormHash(test));
      tests[name] = known;
    }
  }
};

/**
 * Every release tag whose templates hold the guard list, oldest first. Every major, never one: an
 * app keeps the copy it was scaffolded with through later upgrades, so a v31 app can hold a v30 form.
 */
const releaseTags = async (root: string): Promise<readonly string[]> => {
  const listed = await git(['tag', '-l', 'v*', '--sort=version:refname'], root);
  const tags = listed.output.split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  return tags.filter(
    (tag) =>
      Bun.spawnSync(['git', 'cat-file', '-e', `${tag}:${ENTRY}`], { cwd: root }).exitCode === 0,
  );
};

export async function releasedForms(
  root: string,
): Promise<{ readonly forms: Forms; readonly tests: TestForms }> {
  const forms: Forms = {};
  const tests: TestForms = {};
  const scratch = join(root, SCRATCH);
  rmSync(scratch, { recursive: true, force: true });
  try {
    for (const tag of await releaseTags(root)) {
      const dir = join(scratch, tag);
      mkdirSync(dir, { recursive: true });
      // The templates and every module their guard graph imports outside them, exit codes checked.
      await extractTemplates(gitTreeSource(root, tag), dir);
      await collect(forms, tests, join(dir, ENTRY));
    }
    await collect(forms, tests, join(root, ENTRY));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { forms, tests };
}

/**
 * A key's entries in Biome's layout, so the written file is already formatted: on the key's line
 * when one pair, or flat strings that fit the 100 columns; otherwise one per line.
 */
const renderRow = (name: string, items: readonly string[], flat = false): string => {
  const inline = `  '${name}': [${items.join(', ')}],`;
  if (items.length === 1 || (flat && inline.length <= 100)) return inline;
  return `  '${name}': [\n${items.map((item) => `    ${item},`).join('\n')}\n  ],`;
};

export const renderForms = ({ forms, tests }: { forms: Forms; tests: TestForms }): string => {
  const rows = Object.keys(forms)
    .sort()
    .map((name) =>
      renderRow(
        name,
        [...(forms[name] ?? new Map())]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([hash, severity]) => `['${hash}', '${severity}']`),
      ),
    );
  const testRows = Object.keys(tests)
    .sort()
    .map((name) =>
      renderRow(
        name,
        [...(tests[name] ?? new Set())].sort().map((hash) => `'${hash}'`),
        true,
      ),
    );
  return `// GENERATED by \`bun run scripts/lib/guard-refresh-forms.ts --write\` — never hand-edited. Every
// rule-file text each shipped guard was released as (\`guardFormHash\`), with how it reported, so the
// \`vendored-guards\` codemod deletes a stale but unedited copy instead of keeping it as an edit.

export const RELEASED_GUARD_FORMS: Readonly<
  Record<string, readonly (readonly [string, 'error' | 'warning'])[]>
> = {
${rows.join('\n')}
};

/** Every hash each shipped guard's TEST file was released as: an unedited test goes without a note. */
export const RELEASED_GUARD_TEST_FORMS: Readonly<Record<string, readonly string[]>> = {
${testRows.join('\n')}
};
`;
};

if (import.meta.main) {
  const root = repoRoot();
  const rendered = renderForms(await releasedForms(root));
  if (process.argv.includes('--write')) await Bun.write(join(root, FORMS_FILE), rendered);
  const current = await Bun.file(join(root, FORMS_FILE))
    .text()
    .catch(() => '');
  const ok = current === rendered;
  console.log(
    process.argv.includes('--json')
      ? JSON.stringify({ ok, file: FORMS_FILE })
      : ok
        ? `✓ ${FORMS_FILE} holds every released guard form`
        : `✗ ${FORMS_FILE} is stale — bun run scripts/lib/guard-refresh-forms.ts --write`,
  );
  if (!ok) process.exitCode = 1;
}
