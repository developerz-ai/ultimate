// Which test stack a compose file means on this machine, and whose it is. Compose names a project
// after the app, so two checkouts, or two unrelated apps with one name, land on the same containers;
// the labels compose writes on each one say which checkout started them.

// why: Bun ships no synchronous existence check or realpath primitive.
import { existsSync, realpathSync } from 'node:fs';
import type { Runner } from './exec';
import { TEST_COMPOSE_PATH } from './templates/scaffold-test-services';

const COMPOSE = ['docker', 'compose', '-f', TEST_COMPOSE_PATH] as const;

/** Every container of this file's project, stopped ones too, with its labels. */
export const SERVICES_LIST: readonly string[] = [...COMPOSE, 'ps', '--all', '--format', 'json'];
/** `--volumes`: the images declare anonymous volumes, and a stopped stack should leave none. */
export const SERVICES_STOP: readonly string[] = [...COMPOSE, 'down', '--volumes'];
/** Every compose project on the machine. */
export const STACKS_LIST: readonly string[] = [
  'docker',
  'compose',
  'ls',
  '--all',
  '--format',
  'json',
];

/** `1` says a stack another app started is shared on purpose. */
export const SHARED_ENV = 'ULTIMATE_TEST_SERVICES_SHARED';

export interface TestStack {
  readonly project: string;
  readonly services: readonly string[];
  /** The checkouts whose compose file started these containers. */
  readonly roots: readonly string[];
  /** Whether any container is up: `ps --all` lists exited ones too, and those hold no server. */
  readonly running: boolean;
}

export type StackRead =
  | { readonly answered: true; readonly stack?: TestStack }
  | { readonly answered: false };

export type StackRelation =
  | { readonly kind: 'own' }
  | { readonly kind: 'shared'; readonly with: string; readonly why: 'same-app' | 'declared' }
  | { readonly kind: 'collision'; readonly with: string; readonly running: boolean };

type Env = Readonly<Record<string, string | undefined>>;

const CONFIG_FILES = /(?:^|,)com\.docker\.compose\.project\.config_files=([^,]*)/;
const COMPOSE_SUFFIX = `/${TEST_COMPOSE_PATH}`;

/** The checkout a compose file sits in, or `undefined` for a file at any other path. */
export const rootOfCompose = (file: string): string | undefined =>
  file.endsWith(COMPOSE_SUFFIX) ? file.slice(0, -COMPOSE_SUFFIX.length) : undefined;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One JSON document per line, or (older compose) one array. Anything else is no row. */
export function jsonRows(stdout: string): readonly Record<string, unknown>[] {
  const text = stdout.trim();
  const values: unknown[] = text.startsWith('[')
    ? [parseJson(text)].flat()
    : text.split('\n').map(parseJson);
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
  );
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Compose's states for a container that still holds its ports; `exited`/`created`/`dead` do not. */
const LIVE_STATES: ReadonlySet<string> = new Set(['running', 'restarting', 'paused']);

export function parseStack(stdout: string): TestStack | undefined {
  const rows = jsonRows(stdout).filter((row) => stringOf(row['Project']) !== '');
  const project = stringOf(rows[0]?.['Project']);
  if (project === '') return undefined;
  const roots = rows.flatMap((row) => {
    const file = CONFIG_FILES.exec(stringOf(row['Labels']))?.[1];
    const root = file === undefined ? undefined : rootOfCompose(file);
    return root === undefined ? [] : [root];
  });
  return {
    project,
    services: [...new Set(rows.map((row) => stringOf(row['Service'])))].sort(),
    roots: [...new Set(roots)],
    running: rows.some((row) => LIVE_STATES.has(stringOf(row['State']))),
  };
}

/** What compose says is up for this checkout's file. `answered: false` means it could not say. */
export async function readStack(root: string, runner: Runner): Promise<StackRead> {
  try {
    const result = await runner(SERVICES_LIST, { cwd: root });
    if (!result.ok) return { answered: false };
    const stack = parseStack(result.stdout);
    return stack === undefined ? { answered: true } : { answered: true, stack };
  } catch {
    return { answered: false }; // No `docker` on PATH.
  }
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The checkouts other than `root` that started this stack and still exist. */
export const otherRoots = (stack: TestStack, root: string): readonly string[] =>
  stack.roots.filter((other) => real(other) !== real(root) && existsSync(other));

async function gitFact(cwd: string, args: readonly string[], runner: Runner) {
  try {
    const result = await runner(['git', ...args], { cwd });
    const text = result.stdout.trim();
    return result.ok && text !== '' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** One app in two checkouts shares its first commit, or (a shallow clone) its origin. */
async function sameApp(one: string, two: string, runner: Runner): Promise<boolean> {
  for (const args of [
    ['rev-list', '--max-parents=0', 'HEAD'],
    ['remote', 'get-url', 'origin'],
  ]) {
    const [first, second] = await Promise.all([
      gitFact(one, args, runner),
      gitFact(two, args, runner),
    ]);
    if (first !== undefined && first === second) return true;
  }
  return false;
}

/**
 * What the stack is to this checkout. A checkout that no longer exists can use nothing, so its
 * stack is simply there to reuse. One git cannot tie to this app is a collision: a shared name
 * proves nothing, and the caller can still say the share is intended.
 */
export async function relationTo(
  stack: TestStack,
  root: string,
  runner: Runner,
  env: Env,
): Promise<StackRelation> {
  let shared: StackRelation = { kind: 'own' };
  for (const other of otherRoots(stack, root)) {
    if (await sameApp(root, other, runner))
      shared = { kind: 'shared', with: other, why: 'same-app' };
    else if (env[SHARED_ENV] === '1') shared = { kind: 'shared', with: other, why: 'declared' };
    else return { kind: 'collision', with: other, running: stack.running };
  }
  return shared;
}
