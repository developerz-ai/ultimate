#!/usr/bin/env bun
// A stranger's first hour, measured: the PUBLISHED `create-ultimate`, under a clean `HOME` and
// `BUN_INSTALL` (no warm cache, no global config), then the scaffold's own commands — setup, the
// gate, a first feature, the gate again, and with `--image` the container image. Times and sizes.
//
//   bun run scripts/bench/first-hour.ts [--version latest] [--runs 5] [--image] [--out <file.json>]
//     [--json]

// why: Bun has no temp-directory or recursive-walk API; `node:fs` owns the throwaway tree.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only `node:os` answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { exec } from '@ultimat3/cli';
import { parseScriptArgs } from '../lib/args';
import { report } from '../lib/log';
import { spreads } from './bench-spread';
import { type FirstHourSizes, firstHourOk, runFirstHour } from './first-hour-run';
import { boxFacts, readCount } from './http-hello';

const APP = 'firsthour';

/**
 * Every regular file under `dir`, symlinks never followed — Bun's recursive `readdirSync` follows
 * them and loops (`ELOOP`) on an isolated install — skipping directories `skip` names.
 */
function filesUnder(dir: string, skip: ReadonlySet<string> = new Set()): readonly string[] {
  const out: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory() && !skip.has(entry.name)) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  try {
    visit(dir);
    return out;
  } catch {
    return [];
  }
}

/** Bytes the disk holds under `dir`: a hard-linked file counted once, as `du` counts it. */
export const bytesUnder = (dir: string): number | null => {
  const seen = new Set<number>();
  let bytes = 0;
  for (const path of filesUnder(dir)) {
    const stat = statSync(path);
    if (seen.has(stat.ino)) continue;
    seen.add(stat.ino);
    bytes += stat.size;
  }
  return bytes === 0 ? null : bytes;
};

/**
 * The app's own files after the first hour — scaffold, lockfile, migration, manifest — and not
 * `node_modules`, `.x` or `.git`.
 */
export const appFiles = (app: string): number | null => {
  const files = filesUnder(app, new Set(['node_modules', '.x', '.git']));
  return files.length === 0 ? null : files.length;
};

/** `/`'s document bytes off the gate's static export, and its app JS as the budgets step weighed it. */
async function homeBytes(app: string): Promise<Pick<FirstHourSizes, 'homeBytes' | 'homeJsBytes'>> {
  const document = Bun.file(join(app, '.x/verify-static/index.html'));
  const stats: unknown = await Bun.file(join(app, '.x/build-stats.json'))
    .json()
    .catch(() => null);
  const routes = (stats as { routes?: readonly Record<string, unknown>[] } | null)?.routes ?? [];
  const js = routes.find((route) => route['path'] === '/')?.['jsBytes'];
  return {
    homeBytes: (await document.exists()) ? document.size : null,
    homeJsBytes: typeof js === 'number' ? js : null,
  };
}

async function imageMb(app: string): Promise<number | null> {
  const result = await exec(['docker', 'image', 'inspect', '-f', '{{.Size}}', `${APP}:bench`], {
    cwd: app,
  });
  return result.ok ? Math.round(Number(result.stdout.trim()) / 1024 ** 2) : null;
}

const packagesUnder = (app: string): number | null => {
  try {
    return readdirSync(join(app, 'node_modules/.bun')).filter((name) => name !== 'node_modules')
      .length;
  } catch {
    return null;
  }
};

/**
 * One clean first hour in its own fresh directory: the steps, then what they left on disk. The
 * tree is measured, then removed — a scaffold, its install and a throwaway `HOME` are gigabytes.
 */
async function oneRun(version: string, image: boolean) {
  const work = mkdtempSync(join(tmpdir(), 'first-hour-'));
  try {
    return await measuredRun(work, version, image);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function measuredRun(work: string, version: string, image: boolean) {
  const app = join(work, APP);
  // A stranger's machine: no Bun cache, no global config. PATH is kept — Bun and git are the
  // prerequisites, and nothing else is assumed.
  const env = { HOME: join(work, 'home'), BUN_INSTALL: join(work, 'bun'), CI: Bun.env['CI'] };
  const steps = await runFirstHour({ app: APP, work, version, image }, exec, env);
  const modules = bytesUnder(join(app, 'node_modules'));
  const sizes: FirstHourSizes = {
    appFiles: appFiles(app),
    nodeModulesMb: modules === null ? null : Math.round(modules / 1024 ** 2),
    packages: packagesUnder(app),
    ...(await homeBytes(app)),
    imageMb: image ? await imageMb(app) : null,
  };
  // What `latest` resolved to, read off the install: the figure belongs to a version, not a tag.
  const installed: unknown = await Bun.file(join(app, 'node_modules/@ultimat3/cli/package.json'))
    .json()
    .catch(() => null);
  const resolved = (installed as { version?: unknown } | null)?.version;
  return { resolved: typeof resolved === 'string' ? resolved : null, steps, sizes };
}

/** A run as named figures: each step's time when it passed, and every size. */
const figuresOf = (run: Awaited<ReturnType<typeof oneRun>>) => ({
  ...Object.fromEntries(
    run.steps.map((step) => [`${step.name} ms`, step.status === 'ok' ? step.ms : null]),
  ),
  ...run.sizes,
});

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const version = String(args.flags.get('version') ?? 'latest');
  const image = args.flags.get('image') === true;
  const count = readCount(args.flags.get('runs'), 1, { flag: 'runs', min: 1, max: 10 });
  if (typeof count !== 'number') {
    report({ ok: false, script: 'first-hour', summary: 'no run', findings: [count] }, args.json);
  }
  const runs: Awaited<ReturnType<typeof oneRun>>[] = [];
  for (let index = 0; index < count; index += 1) runs.push(await oneRun(version, image));
  const data = { version, box: boxFacts(Bun.env), runs, spread: spreads(runs.map(figuresOf)) };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  const broken = runs.find((run) => !firstHourOk(run.steps));
  const failed = broken?.steps.find((step) => step.status === 'failed');
  report(
    {
      ok: broken === undefined,
      script: 'first-hour',
      summary:
        failed === undefined
          ? `create-ultimate@${version}, ${count} clean run(s): ${Object.entries(data.spread)
              .flatMap(([name, spread]) => (spread === null ? [] : [`${name} ${spread.median}`]))
              .join(', ')}`
          : `${failed.name} failed after ${failed.ms} ms: ${failed.tail ?? ''}`,
      findings:
        failed === undefined || broken === undefined
          ? []
          : [
              {
                code: 'X_BENCH_RUN_FAILED',
                cause: `${failed.command} failed in a clean first run, so no first-hour figure exists: ${failed.tail ?? ''}`,
                // The step's own command and output are in `data.runs[].steps`; rerunning the whole
                // hour is the one line that cannot splice a hostile path into a shell.
                fix: 'bun run scripts/bench/first-hour.ts --runs 1 --json',
              },
            ],
      data,
    },
    args.json,
  );
}
