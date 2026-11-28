#!/usr/bin/env bun
// Does a deploy workflow publish this commit? Only when a path the app ships changed since the
// last green publish — read from GitHub's compare of the two commits — and on every doubt. The
// paths an app never ships are listed; anything else, a new top-level directory included, ships.
//
//   bun run scripts/lib/ci/deploy-due.ts --app social|docs <compare.json>

// Imports nothing, on purpose: deploy-social-demo.yml's build job holds the registry credential
// and runs this on bun alone, with no `bun install` beside the secret (`deploy-due.test.ts`).
// Always exits 0 and prints its `--json` document: a doubt is a publish, never a red run.

export type DeployApp = 'social' | 'docs';

/** Prose and tooling no deploy reads: no image layer and no static page is built from them. */
const NEVER_SHIPPED: readonly RegExp[] = [
  /^docs\//,
  /^scripts\//,
  /^examples\//,
  /^\.claude\//,
  /^[^/]+\.md$/,
];

/**
 * Per app, besides `NEVER_SHIPPED`. The demo image drops what its `.dockerignore` drops
 * (dummy/social-media-clone/docker/Dockerfile.monorepo.dockerignore); the docs site reads
 * `wiki/`, its own tree, `framework.manifest.json` and the framework packages
 * (dummy/docs-site/apps/web/shared/docs.ts). Each workflow's own file always ships.
 */
const ALSO_UNSHIPPED: Readonly<Record<DeployApp, readonly RegExp[]>> = {
  social: [
    /^wiki\//,
    /^dummy\/docs-site\//,
    /^packages\/create-ultimate\//,
    /^\.github\/(?!workflows\/deploy-social-demo\.yml$)/,
  ],
  docs: [
    /^dummy\/social-media-clone\//,
    /^docker\//,
    /^\.github\/(?!workflows\/deploy-docs-site\.yml$)/,
  ],
};

/** GitHub's compare lists at most this many files: a full list may hide the one that ships. */
export const COMPARE_FILE_CAP = 300;

export interface DeployVerdict {
  readonly due: boolean;
  readonly reason: string;
  /** The changed paths that ship: why `due` is true. */
  readonly shipped: readonly string[];
}

const doubtful = (path: string): boolean => path.startsWith('"') || path.split('/').includes('..');

/** A manifest anywhere ships: the image installs every workspace member's against `bun.lock`. */
const ships = (app: DeployApp, path: string): boolean =>
  doubtful(path) ||
  /(?:^|\/)package\.json$/.test(path) ||
  ![...NEVER_SHIPPED, ...ALSO_UNSHIPPED[app]].some((pattern) => pattern.test(path));

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const publish = (reason: string, shipped: readonly string[] = []): DeployVerdict => ({
  due: true,
  reason,
  shipped,
});

/** `compare` is `{ status, files: [filename…] }` from the compare API, or anything at all. */
export function deployDue(app: DeployApp, compare: unknown): DeployVerdict {
  const doc = record(compare);
  const status = doc?.['status'];
  if (typeof status !== 'string') return publish('no comparison with the last publish');
  if (status === 'identical')
    return { due: false, reason: 'the last publish is this tree', shipped: [] };
  if (status !== 'ahead') return publish(`this commit is ${status} of the last publish`);
  const files = doc?.['files'];
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
    return publish('the comparison lists no files');
  }
  if (files.length >= COMPARE_FILE_CAP) {
    return publish(`${String(files.length)} changed files: the list may be capped`);
  }
  const shipped = files.filter((path) => ships(app, path));
  return shipped.length > 0
    ? publish(`${String(shipped.length)} of ${String(files.length)} changed path(s) ship`, shipped)
    : { due: false, reason: `none of ${String(files.length)} changed path(s) ship`, shipped };
}

const isApp = (value: string | undefined): value is DeployApp =>
  value === 'social' || value === 'docs';

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const at = argv.indexOf('--app');
  const app = at === -1 ? undefined : argv[at + 1];
  const path = argv.find((arg, index) => !arg.startsWith('--') && (at === -1 || index !== at + 1));
  const file = path === undefined ? undefined : Bun.file(path);
  const text = file !== undefined && (await file.exists()) ? await file.text() : undefined;
  let compare: unknown;
  try {
    compare = text === undefined ? undefined : JSON.parse(text);
  } catch {
    compare = undefined; // An unreadable comparison is no comparison: the verdict below publishes.
  }
  const verdict = isApp(app)
    ? deployDue(app, compare)
    : publish(`--app is social or docs, and was ${app ?? 'not given'}`);
  const summary = `due=${String(verdict.due)}: ${verdict.reason}`;
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({ ok: true, script: 'deploy-due', summary, data: verdict })}\n`,
  );
}
