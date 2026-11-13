// A hop's missing shipped guards, installed by the CLI the hop just installed (`x g guard <name>`,
// that release's own template) — each one only if the `boundaries` step finds nothing more with it
// on disk. One the tree breaks is taken back out — every file its run listed, the refreshed manifest
// too, put back as it was — and listed; an app-modified guard is never touched (`differs`).

// why: Bun exposes no path-join primitive; a written guard's path is relative to the app root.
import { join } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { t } from '@ultimat3/schema';
import type { ExecResult } from './exec';
import { documentIn } from './upgrade-document';

const GENERATED = t.object({
  data: t.optional(t.object({ files: t.optional(t.array(t.string)) })),
});
const STEP = t.object({
  name: t.string,
  findings: t.optional(t.array(t.object({ code: t.string }))),
});
const BOUNDARIES = t.object({ steps: t.array(STEP) });

/** A missing guard the hop did not install, with what stood in the way. */
export interface WithheldGuard {
  readonly name: string;
  /** The command that writes it anyway; `x verify` then names what it finds. */
  readonly add: string;
  /** How many findings it would add to `boundaries`; null when that could not be measured. */
  readonly findings: number | null;
}

export interface GuardInstall {
  readonly installed: readonly string[];
  readonly withheld: readonly WithheldGuard[];
}

/** Runs the installed CLI with these arguments in the app root. */
export type InstalledCli = (args: readonly string[]) => Promise<ExecResult>;

const MEASURE = ['verify', '--only', 'boundaries', '--json'] as const;

/** `boundaries`' finding count, or undefined when this CLI answered no step by that name. */
const boundariesCount = async (cli: InstalledCli): Promise<number | undefined> => {
  const parsed = BOUNDARIES.safeParse(documentIn((await cli(MEASURE)).stdout));
  if (parsed.issues !== undefined) return undefined;
  const steps = (
    parsed.value as { readonly steps: readonly { name: string; findings?: unknown[] }[] }
  ).steps;
  const step = steps.find((candidate) => candidate.name === 'boundaries');
  return step === undefined ? undefined : (step.findings ?? []).length;
};

/** A path's bytes before a run, or null when it did not exist: what a rollback puts back. */
type Prior = ReadonlyMap<string, Uint8Array | null>;

/** One generator run: the paths it listed, and how to put each back. */
interface Generated {
  readonly files: readonly string[];
  readonly prior: Prior;
}

/**
 * Every path a guard run can write, read before it runs: the guard and its test, and the generated
 * contracts `x g` refreshes and lists beside them (`x.manifest.json`, `openapi*.json`). A listed
 * path outside this set has no known prior state and is never deleted.
 */
const snapshot = async (root: string, name: string): Promise<Prior> => {
  const paths = new Set([`guards/${name}.ts`, `guards/${name}.test.ts`, MANIFEST_FILENAME]);
  paths.add('openapi.json');
  for await (const path of new Bun.Glob('openapi*.json').scan({ cwd: root })) paths.add(path);
  const prior = new Map<string, Uint8Array | null>();
  for (const path of paths) {
    const file = Bun.file(join(root, path));
    prior.set(path, (await file.exists()) ? await file.bytes() : null);
  }
  return prior;
};

/** Writes one guard; what it listed with what stood there before, or undefined when refused. */
const generate = async (
  cli: InstalledCli,
  root: string,
  name: string,
): Promise<Generated | undefined> => {
  const prior = await snapshot(root, name);
  const result = await cli(['g', 'guard', name, '--json']);
  if (!result.ok) return undefined;
  const parsed = GENERATED.safeParse(documentIn(result.stdout));
  const listed =
    parsed.issues === undefined
      ? (parsed.value as { readonly data?: { readonly files?: readonly string[] } }).data?.files
      : undefined;
  return { files: listed ?? [`guards/${name}.ts`, `guards/${name}.test.ts`], prior };
};

/** Puts each listed path back: rewritten when it existed before the run, deleted when it did not. */
const rollback = async (root: string, run: Generated | undefined): Promise<void> => {
  for (const path of run?.files ?? []) {
    const before = run?.prior.get(path);
    // Unknown prior state: leaving a file is recoverable, deleting a committed one is not.
    if (before === undefined) continue;
    const file = Bun.file(join(root, path));
    if (before !== null) await Bun.write(file, before);
    else if (await file.exists()) await file.delete();
  }
};

/**
 * Every missing guard, installed or withheld. All at once first — two `boundaries` runs when the
 * tree breaks none of them, the usual case — and one at a time only when the count rose, so the
 * guard that found something is the one taken back out.
 */
export async function installMissingGuards(input: {
  readonly cli: InstalledCli;
  readonly root: string;
  readonly missing: readonly { readonly name: string; readonly add: string }[];
}): Promise<GuardInstall> {
  const { cli, root, missing } = input;
  if (missing.length === 0) return { installed: [], withheld: [] };
  const unmeasured = (guard: { name: string; add: string }): WithheldGuard => ({
    name: guard.name,
    add: guard.add,
    findings: null,
  });
  const base = await boundariesCount(cli);
  if (base === undefined) return { installed: [], withheld: missing.map(unmeasured) };

  const written = new Map<string, Generated>();
  const withheld: WithheldGuard[] = [];
  for (const guard of missing) {
    const run = await generate(cli, root, guard.name);
    if (run === undefined) withheld.push(unmeasured(guard));
    else written.set(guard.name, run);
  }
  if (written.size === 0) return { installed: [], withheld };
  const together = await boundariesCount(cli);
  if (together !== undefined && together <= base) {
    return { installed: [...written.keys()], withheld: sortByName(withheld) };
  }

  // Newest first, so each artifact ends at the bytes it held before the first run.
  for (const run of [...written.values()].reverse()) await rollback(root, run);
  const installed: string[] = [];
  let held = base;
  for (const guard of missing.filter(({ name }) => written.has(name))) {
    const run = await generate(cli, root, guard.name);
    const count = run === undefined ? undefined : await boundariesCount(cli);
    if (run !== undefined && count !== undefined && count <= held) {
      installed.push(guard.name);
      held = count;
      continue;
    }
    await rollback(root, run);
    withheld.push({ ...guard, findings: count === undefined ? null : count - held });
  }
  return { installed, withheld: sortByName(withheld) };
}

const sortByName = (list: readonly WithheldGuard[]): readonly WithheldGuard[] =>
  [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
