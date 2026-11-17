// Single responsibility: read `wiki/Building-Your-Own-Base.md`'s recipes as the files they claim to
// be — every `ts` fence under a `## Recipe:` heading whose first line names an `apps/…` path — and
// load one, written to that path in a scratch app, as a module. `wiki-fences` compiles each fence;
// `scripts/base-recipes/*.test.ts` RUN them, so a recipe that typechecks and does not work fails.

// why: a scratch directory and its removal; Bun has no temporary-directory or recursive-delete API.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFences } from './readme-fences';
import { ScriptError } from './script-error';

export const RECIPE_PAGE = 'wiki/Building-Your-Own-Base.md';

/** Under `.x/`, which git and Biome ignore — and outside `node_modules`, where `paths` do not apply. */
const SCRATCH_PARENT = '.x';

const RECIPE_HEADING = /^## Recipe: (.+)$/;
const SECTION_HEADING = /^## /;
const PATH_COMMENT = /^\/\/ (apps\/[\w./-]+\.ts)\b/;

export interface RecipeFile {
  /** The heading's text after `Recipe: `. */
  readonly recipe: string;
  /** The app path the fence's first line names: where a reader pastes it. */
  readonly path: string;
  /** 1-based page line of the fence's first code line. */
  readonly line: number;
  readonly code: string;
}

/** Every recipe file on the page, in page order. Pure over the text. */
export function recipeFiles(markdown: string): readonly RecipeFile[] {
  const lines = markdown.split('\n');
  const files: RecipeFile[] = [];
  let recipe: string | undefined;
  let start = 0;
  const flush = (end: number): void => {
    if (recipe === undefined) return;
    const section = lines.slice(start, end).join('\n');
    for (const fence of readFences(recipe, section)) {
      const path = PATH_COMMENT.exec(fence.code[0] ?? '')?.[1];
      if (path === undefined || fence.lang !== 'ts') continue;
      files.push({ recipe, path, line: start + fence.readmeLine, code: fence.code.join('\n') });
    }
  };
  lines.forEach((line, index) => {
    if (!SECTION_HEADING.test(line)) return;
    flush(index);
    recipe = RECIPE_HEADING.exec(line)?.[1];
    start = index;
  });
  flush(lines.length);
  return files;
}

export interface LoadedRecipe {
  readonly file: RecipeFile;
  /** The module's exports, as loaded — the proof narrows what it reads. */
  readonly exports: Readonly<Record<string, unknown>>;
  /** Removes the scratch app. Call it in `afterAll`. */
  dispose(): Promise<void>;
}

/**
 * Write the fence for `path` into a fresh scratch app under the repo root — with a `tsconfig.json`
 * extending the base, so `@ultimat3/*` resolves to `packages/*` as it does for every script — and
 * import it. A page holding no such fence is a refusal: a proof that loaded nothing proves nothing.
 */
export async function loadRecipe(root: string, path: string): Promise<LoadedRecipe> {
  const page = await Bun.file(join(root, RECIPE_PAGE)).text();
  const file = recipeFiles(page).find((candidate) => candidate.path === path);
  if (file === undefined)
    throw unscanned(`no \`\`\`ts fence under a "## Recipe:" heading opens with // ${path}`);
  await mkdir(join(root, SCRATCH_PARENT), { recursive: true });
  const dir = await mkdtemp(join(root, SCRATCH_PARENT, 'base-recipe-'));
  await Bun.write(join(dir, 'tsconfig.json'), '{ "extends": "../../tsconfig.base.json" }\n');
  await Bun.write(join(dir, file.path), `${file.code}\n`);
  const exports: Readonly<Record<string, unknown>> = await import(join(dir, file.path));
  return { file, exports, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The recipe's exports as the proof's declared contract `T`, once every name it lists is there. A
 * name the page renamed or dropped is a failure naming it, never an `undefined` call further down.
 */
export function exportsOf<T>(loaded: LoadedRecipe, names: readonly (keyof T & string)[]): T {
  const missing = names.filter((name) => loaded.exports[name] === undefined);
  if (missing.length > 0) {
    throw unscanned(`the fence for ${loaded.file.path} no longer exports ${missing.join(', ')}`);
  }
  return loaded.exports as T;
}

/** `X_CORPUS_UNSCANNED`: the page no longer holds what the proof was written against. */
const unscanned = (what: string): ScriptError =>
  new ScriptError({
    code: 'X_CORPUS_UNSCANNED',
    cause: `${RECIPE_PAGE}: ${what}, so its proof would run nothing`,
    fix: `bun test ./scripts/base-recipes/   # then edit ${RECIPE_PAGE} or the proof that names the path`,
  });
