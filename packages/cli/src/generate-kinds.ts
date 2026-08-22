// Which generators exist, and how one is named on a command line. Split from `cmd-generate.ts`
// because "what a generator emits" and "which spelling reaches it" are two jobs — and the file
// that held both had reached the 500-line ceiling, one generator short of failing its own gate.

import { nearestName } from '@ultimat3/core';
import { BadFlagError, MissingPositionalError, UnknownCommandError } from './errors';
import type { Surface } from './templates';

export const GENERATORS = [
  'resource',
  'action',
  'mutator',
  'backfill',
  'job',
  'route',
  'policy',
  'entity',
  'query',
  'task',
  'island',
  'admin:page',
  'guard',
] as const;

export type Generator = (typeof GENERATORS)[number];

/**
 * A resource slice is app-surface by construction: it ships a live query, a form with a signal,
 * two actions and a policy, and `site/` is the 0kb, never-hydrated surface that may not import
 * `app/`. The documented shape is the slice in `app/` plus a separate public route
 * (`docs/architecture/15-adding-a-feature.md`), so the flag is refused before anything is written
 * rather than emitting a slice that fails the app's own budget and boundary gates.
 */
export function assertSurfaceSupported(kind: Generator, surface: Surface, name: string): void {
  if (kind !== 'resource' || surface !== 'site') return;
  throw new BadFlagError({
    flag: 'surface',
    command: 'g resource',
    reason: 'a resource slice is app-surface — site/ ships 0kb JS and may not import app/',
    // The caller's own name, not `<name>`: a `fix:` is copied and run verbatim, and `x g resource
    // <name>` is a shell redirect (`bash: name: No such file or directory`), not a command.
    fix: `x g resource ${name} && x g route ${name} --surface site`,
  });
}

/**
 * The generator a spelling reaches, or a refusal that leads with the one it is nearest.
 *
 * The lead used to be the literal `g resource`, whatever was typed: `x g rout x` — one edit from
 * `route` — answered `fix: x g resource`, the WRONG PRIMITIVE, and one that refuses in turn
 * because it carries no `<name>`. `nearestName` is what `parse.ts` already does with a mistyped
 * command, over this file's own list.
 *
 * Two rules hold the fix line to a command that runs. A near miss is completed with that
 * generator's own `EXAMPLE_NAME`, because `x g route <name>` pasted into a shell is a redirect.
 * A word near NOTHING gets `x help g` rather than an invented lead — the same rule `parse.test.ts`
 * pins for a command that resembles nothing, and the reason `nearestName` is never asked about an
 * ABSENT kind: the empty string is within the cutoff of `job`, so `x g` would "suggest" a
 * generator nobody typed.
 */
export function readKind(raw: string | undefined): Generator {
  const kinds: readonly string[] = GENERATORS;
  if (raw !== undefined && kinds.includes(raw)) return raw as Generator;
  const near = raw === undefined ? undefined : nearestName(raw, kinds);
  const suggestion = GENERATORS.find((kind) => kind === near);
  throw new UnknownCommandError({
    path: `g ${raw ?? ''}`.trim(),
    known: GENERATORS,
    suggestion: suggestion === undefined ? 'help g' : `g ${suggestion} ${EXAMPLE_NAME[suggestion]}`,
  });
}

/** Two surfaces, spelled exactly. A typo that fell through to `app` would scaffold the wrong one. */
export function readSurface(raw: string | undefined, kind: Generator, name: string): Surface {
  if (raw === undefined || raw === 'app') return 'app';
  if (raw === 'site') return 'site';
  throw new BadFlagError({
    flag: 'surface',
    command: 'g',
    reason: `"${raw}" is not a surface (site, app)`,
    fix: `x g ${kind} ${name} --surface app`,
  });
}

/**
 * The missing `<name>` positional. It used to throw `X_CLI_UNKNOWN_COMMAND` — for a command form
 * that IS known — with `fix: "x g route <name>"`, which pasted into a shell is a redirect
 * (`bash: name: No such file or directory`). The code now says what is actually wrong, and the fix
 * is a command that runs.
 */
export function readName(raw: string | undefined, kind: Generator): string {
  if (raw !== undefined) return raw;
  throw new MissingPositionalError({
    command: `g ${kind}`,
    positional: 'name',
    example: `x g ${kind} ${EXAMPLE_NAME[kind]}`,
  });
}

/** One runnable example per generator, so the `fix:` is a command and not a shape. */
const EXAMPLE_NAME: Readonly<Record<Generator, string>> = {
  resource: 'invoice',
  action: 'publish-post',
  mutator: 'rename-post',
  backfill: 'backfill-slugs',
  job: 'send-digest',
  route: 'posts',
  policy: 'post',
  entity: 'post',
  query: 'recent-posts',
  task: 'nightly-digest',
  island: 'counter',
  'admin:page': 'ops',
  guard: 'migration-safety',
};
