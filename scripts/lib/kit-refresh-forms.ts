#!/usr/bin/env bun
// Every text a release wrote as `.claude/commands/<n>.md` or `.claude/agents/<n>.md`, hashed with
// the app's name normalised (`kitFormHash`): read from each release tag's own templates and the
// tree's, written to `packages/cli/src/templates/kit-released-forms.ts`, so the `agent-kit` codemod
// tells an unedited old file from an app's edit. A recorded hash is history: only ever added to.
//
//   bun run scripts/lib/kit-refresh-forms.ts [--write] [--json]

// why: Bun ships no temp-directory or recursive-remove API.
import { mkdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { KIT_FORM_NAME, kitFormHash } from '../../packages/cli/src/app-kit-forms';
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { RELEASED_KIT_FORMS } from '../../packages/cli/src/templates/kit-released-forms';
import { names } from '../../packages/cli/src/templates/naming';
import { git } from './release-due-git';
import { repoRoot } from './run';
import { ScriptError } from './script-error';

export const FORMS_FILE = 'packages/cli/src/templates/kit-released-forms.ts';
const TEMPLATES = 'packages/cli/src/templates';
const SCRATCH = 'packages/cli/node_modules/.cache/kit-released-forms';
/** The two template files that wrote the files the kit now owns, and the function each exports. */
const SOURCES = [
  { file: 'scaffold-claude-commands.ts', exported: 'claudeCommandFiles' },
  { file: 'scaffold-claude-agents.ts', exported: 'claudeAgentFiles' },
] as const;
type Forms = Record<string, Set<string>>;

interface GeneratedFile {
  readonly path: string;
  readonly contents: unknown;
}

const failed = (ref: string, cause: string): ScriptError =>
  new ScriptError({
    code: 'X_KIT_FORMS_ARCHIVE_FAILED',
    cause: `${ref} could not be read for the released kit forms: ${cause}`,
    fix: `git fetch --no-tags origin ${quoteArg(`+refs/tags/${ref}:refs/tags/${ref}`)} && bun run scripts/lib/kit-refresh-forms.ts --write`,
  });

const add = (forms: Forms, files: readonly GeneratedFile[]): void => {
  for (const { path, contents } of files) {
    if (typeof contents !== 'string') continue;
    const known = forms[path] ?? new Set<string>();
    known.add(kitFormHash(contents, KIT_FORM_NAME));
    forms[path] = known;
  }
};

/** Renders one template module with the fixed name; a file the ref lacks is nothing released. */
const collect = async (forms: Forms, module: string, exported: string): Promise<void> => {
  const loaded: unknown = await import(module);
  const render = (loaded as Record<string, unknown>)[exported];
  if (typeof render !== 'function') return;
  add(forms, (render as (app: unknown) => readonly GeneratedFile[])(names(KIT_FORM_NAME)));
};

const releaseTags = async (root: string): Promise<readonly string[]> => {
  const listed = await git(['tag', '-l', 'v*', '--sort=version:refname'], root);
  return listed.output.split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
};

const fromTag = async (root: string, tag: string, dir: string, forms: Forms): Promise<void> => {
  mkdirSync(dir, { recursive: true });
  for (const { file, exported } of SOURCES) {
    const shown = await git(['show', `${tag}:${TEMPLATES}/${file}`], root);
    // An early release wrote these from `scaffold-claude.ts`: it holds no form to record here.
    if (!shown.ok) continue;
    const path = join(dir, file);
    await Bun.write(path, shown.output);
    await collect(forms, path, exported).catch((error: unknown) => {
      throw failed(tag, error instanceof Error ? error.message : 'the template did not load');
    });
  }
};

export async function releasedForms(root: string): Promise<Forms> {
  const forms: Forms = {};
  const scratch = join(root, SCRATCH);
  rmSync(scratch, { recursive: true, force: true });
  try {
    for (const tag of await releaseTags(root)) await fromTag(root, tag, join(scratch, tag), forms);
    // The tree stands in for the next tag, while it still holds the files the kit replaces.
    for (const { file, exported } of SOURCES) {
      const path = join(root, TEMPLATES, file);
      if (await Bun.file(path).exists()) await collect(forms, path, exported);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return forms;
}

/** The regenerated table plus every hash the committed one recorded: history is only added to. */
export function withRecorded(
  regenerated: Forms,
  recorded: Readonly<Record<string, readonly string[]>>,
): Forms {
  const merged: Forms = {};
  for (const path of new Set([...Object.keys(regenerated), ...Object.keys(recorded)])) {
    merged[path] = new Set([
      ...(Object.hasOwn(recorded, path) ? (recorded[path] ?? []) : []),
      ...(regenerated[path] ?? []),
    ]);
  }
  return merged;
}

/** Biome's layout: flat when the row fits 100 columns, otherwise one hash per line. */
export const renderForms = (forms: Forms): string => {
  const rows = Object.keys(forms)
    .sort()
    .map((path) => {
      const items = [...(forms[path] ?? [])].sort().map((hash) => `'${hash}'`);
      const inline = `  '${path}': [${items.join(', ')}],`;
      return inline.length <= 100
        ? inline
        : `  '${path}': [\n${items.map((item) => `    ${item},`).join('\n')}\n  ],`;
    });
  return `// GENERATED by \`bun run scripts/lib/kit-refresh-forms.ts --write\` — never hand-edited. Every
// text a release wrote as a \`.claude/commands/<n>.md\` or \`.claude/agents/<n>.md\` (\`kitFormHash\`,
// the app's name normalised), so the \`agent-kit\` codemod deletes an unedited old file and renames an edit.

export const RELEASED_KIT_FORMS: Readonly<Record<string, readonly string[]>> = {
${rows.join('\n')}
};
`;
};

if (import.meta.main) {
  const root = repoRoot();
  const rendered = renderForms(withRecorded(await releasedForms(root), RELEASED_KIT_FORMS));
  if (process.argv.includes('--write')) await Bun.write(join(root, FORMS_FILE), rendered);
  const current = await Bun.file(join(root, FORMS_FILE))
    .text()
    .catch(() => '');
  const ok = current === rendered;
  console.log(
    process.argv.includes('--json')
      ? JSON.stringify({ ok, file: FORMS_FILE })
      : ok
        ? `✓ ${FORMS_FILE} holds every released kit form`
        : `✗ ${FORMS_FILE} is stale — bun run scripts/lib/kit-refresh-forms.ts --write`,
  );
  if (!ok) process.exitCode = 1;
}
