// A hop's missing shipped guards, installed by the CLI the hop just installed (`x g guard <name>`,
// that release's own template) — each one only if the `boundaries` step finds nothing more with it
// on disk. A guard the tree already breaks is taken back out and listed, so a hop is never turned
// red by a rule the app never had; an app-modified guard is never touched (`differs` is a listing).

// why: Bun exposes no path-join primitive; a written guard's path is relative to the app root.
import { join } from 'node:path';
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

/** Writes one guard; the files it created, or undefined when the generator refused. */
const generate = async (
  cli: InstalledCli,
  root: string,
  name: string,
): Promise<readonly string[] | undefined> => {
  const conventional = [`guards/${name}.ts`, `guards/${name}.test.ts`];
  const before = new Set<string>();
  for (const path of conventional) if (await Bun.file(join(root, path)).exists()) before.add(path);
  const result = await cli(['g', 'guard', name, '--json']);
  if (!result.ok) return undefined;
  const parsed = GENERATED.safeParse(documentIn(result.stdout));
  const listed =
    parsed.issues === undefined
      ? (parsed.value as { readonly data?: { readonly files?: readonly string[] } }).data?.files
      : undefined;
  return (listed ?? conventional).filter((path) => !before.has(path));
};

const remove = async (root: string, files: readonly string[]): Promise<void> => {
  for (const path of files) {
    const file = Bun.file(join(root, path));
    if (await file.exists()) await file.delete();
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

  const written = new Map<string, readonly string[]>();
  const withheld: WithheldGuard[] = [];
  for (const guard of missing) {
    const files = await generate(cli, root, guard.name);
    if (files === undefined) withheld.push(unmeasured(guard));
    else written.set(guard.name, files);
  }
  if (written.size === 0) return { installed: [], withheld };
  const together = await boundariesCount(cli);
  if (together !== undefined && together <= base) {
    return { installed: [...written.keys()], withheld: sortByName(withheld) };
  }

  for (const files of written.values()) await remove(root, files);
  const installed: string[] = [];
  let held = base;
  for (const guard of missing.filter(({ name }) => written.has(name))) {
    const files = await generate(cli, root, guard.name);
    const count = files === undefined ? undefined : await boundariesCount(cli);
    if (files !== undefined && count !== undefined && count <= held) {
      installed.push(guard.name);
      held = count;
      continue;
    }
    await remove(root, files ?? []);
    withheld.push({ ...guard, findings: count === undefined ? null : count - held });
  }
  return { installed, withheld: sortByName(withheld) };
}

const sortByName = (list: readonly WithheldGuard[]): readonly WithheldGuard[] =>
  [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
