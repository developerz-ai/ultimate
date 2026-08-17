// The I/O half of `scripts/readme-fences.ts`: read every package README's `ts`/`tsx` fence, write
// them into a typecheck-only fixture, run `tsc` over it and map each diagnostic back to the block
// and the README line it came from. No new dependency — Bun writes the files and the repo's own
// `typescript` devDependency compiles them.

import { join } from 'node:path';
import { run } from './run';

export const README_GLOB = 'packages/*/README.md';

/** Under `node_modules/`, which is already ignored — a gate that leaves artefacts in the tree is a
 * gate whose next run reads its own output. `--noEmit` plus `composite: false` means no
 * `.tsbuildinfo`, so this cannot collide with `bun run typecheck`'s `tsc -b`. */
export const FIXTURE_DIR = 'node_modules/.cache/ultimate-readme-fences';

export interface Fence {
  readonly pkg: string;
  /** 1-based line of the fence's FIRST code line in the README, so `path:line` opens it. */
  readonly readmeLine: number;
  readonly lang: 'ts' | 'tsx';
  readonly code: readonly string[];
}

const OPEN = /^\s*```\s*([A-Za-z0-9+#-]*)\s*$/;
const CLOSE = /^\s*```\s*$/;

/** Every `ts`/`tsx` fence in one README, in order. Pure over the text. */
export function readFences(pkg: string, markdown: string): readonly Fence[] {
  const fences: Fence[] = [];
  const lines = markdown.split('\n');
  let lang: string | undefined;
  let buffer: string[] = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (lang === undefined) {
      const opened = OPEN.exec(line);
      if (opened === null) continue;
      lang = (opened[1] ?? '').toLowerCase();
      buffer = [];
      start = index + 2;
      continue;
    }
    if (!CLOSE.test(line)) {
      buffer.push(line);
      continue;
    }
    if (lang === 'ts' || lang === 'tsx') {
      fences.push({ pkg, readmeLine: start, lang, code: buffer });
    }
    lang = undefined;
  }
  return fences;
}

export const readAllFences = async (root: string): Promise<readonly Fence[]> => {
  const fences: Fence[] = [];
  const paths: string[] = [];
  for await (const path of new Bun.Glob(README_GLOB).scan({ cwd: root, absolute: false })) {
    paths.push(path);
  }
  for (const path of paths.sort()) {
    const pkg = path.split('/')[1] ?? '';
    fences.push(...readFences(pkg, await Bun.file(join(root, path)).text()));
  }
  return fences;
};

/** One fence as one module on disk, and the fence a diagnostic on any of its lines belongs to. */
interface Fixture {
  readonly file: string;
  readonly text: string;
  readonly fence: Fence;
}

/**
 * ONE MODULE PER FENCE, and the alternative was measured rather than assumed.
 *
 * A README reads as a narrative — block 1 declares `publishPost`, block 4 calls it — so
 * concatenating a package's blocks into one module ought to have rescued most of them. It does not:
 * per fence, 158 of 170 fail; concatenated, 156, because a block the compiler cannot PARSE has to
 * come out of the fixture and every later block that used its declarations fails with it. Two
 * designs, the same answer, and this is the one with no cross-block coupling and no seam artefacts
 * — a diagnostic here is about the block it is written in and nothing else.
 */
export function buildFixtures(
  fences: readonly Fence[],
  skip: (fence: Fence) => boolean = () => false,
): readonly Fixture[] {
  const seen = new Map<string, number>();
  const fixtures: Fixture[] = [];
  for (const fence of fences) {
    const index = seen.get(fence.pkg) ?? 0;
    seen.set(fence.pkg, index + 1);
    if (skip(fence)) continue;
    fixtures.push({
      file: `${fence.pkg}__${index}.${fence.lang}`,
      // `export {}` makes it a module: as scripts, two fixtures declaring `const config` share one
      // global scope and collide, and the collision would be the fixture's bug, not the README's.
      text: `${fence.code.join('\n')}\nexport {};\n`,
      fence,
    });
  }
  return fixtures;
}

const TSCONFIG = (exclude: readonly string[]): string =>
  JSON.stringify(
    {
      extends: '../../../tsconfig.base.json',
      compilerOptions: {
        noEmit: true,
        composite: false,
        incremental: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
      },
      // The base config excludes `node_modules`, and this fixture lives inside it — inherited, the
      // compiler finds no inputs at all and answers TS18003 instead of typechecking anything.
      exclude,
      include: ['*.ts', '*.tsx'],
    },
    null,
    2,
  );

export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly code: number;
  readonly text: string;
}

const DIAGNOSTIC = /^(?:.*[/\\])?([\w.-]+\.tsx?)\((\d+),\d+\): error TS(\d+): (.*)$/gm;

export const parseDiagnostics = (output: string): readonly Diagnostic[] =>
  [...output.matchAll(DIAGNOSTIC)].map((match) => ({
    file: match[1] as string,
    line: Number(match[2]),
    code: Number(match[3]),
    text: match[4] as string,
  }));

/**
 * A diagnostic the compiler raises while PARSING. It matters because `tsc` reports no semantic
 * diagnostics at all for a program that has one — measured: a fixture with `const a: number = 'x'`
 * beside a single unparseable fence reports the fence and says nothing about the assignment. A
 * check that stopped at one pass would go quiet across the whole repo the day one README gained an
 * elision, which is the exact false green this file exists to avoid.
 */
export const isSyntactic = (diagnostic: Diagnostic): boolean =>
  diagnostic.code < 2000 || diagnostic.code === 2657;

export interface TscRun {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** Non-empty when `tsc` itself could not run — a missing binary, a config it refused. */
  readonly failure: string | undefined;
}

/** Write the fixture and compile it. The one impure step. */
export async function compileFixtures(
  root: string,
  fixtures: readonly Fixture[],
  exclude: readonly string[] = [],
): Promise<TscRun> {
  const dir = join(root, FIXTURE_DIR);
  await Bun.$`rm -rf ${dir}`.quiet();
  for (const fixture of fixtures) await Bun.write(join(dir, fixture.file), fixture.text);
  await Bun.write(join(dir, 'tsconfig.json'), TSCONFIG(exclude));
  const result = await run(
    [join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', join(dir, 'tsconfig.json')],
    { cwd: root },
  );
  const diagnostics = parseDiagnostics(result.output);
  // A non-zero exit with nothing this can attribute is `tsc` refusing to run — TS18003, a missing
  // binary, a config error. Reporting that as "every example compiles" is the false green.
  return {
    ok: result.ok,
    diagnostics,
    failure: result.ok || diagnostics.length > 0 ? undefined : result.output.slice(0, 400),
  };
}

/**
 * Which fence a diagnostic belongs to. The line is not consulted: one fixture is one fence, and a
 * diagnostic on its trailing `export {}` is still that block's. A lookup that could answer
 * `undefined` would DROP a diagnostic, and a dropped syntax error is a run that skips every
 * semantic check without saying so — see `isSyntactic`.
 */
export const fenceOf = (fixtures: readonly Fixture[], file: string): Fence | undefined =>
  fixtures.find((one) => one.file === file)?.fence;

export type { Fixture };
