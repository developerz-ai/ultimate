// `create-ultimate repro <bundle.json>`: a bug's `x repro --bundle` file, opened into a scratch app —
// the scaffold `x new` writes, the bundle's reproducer under `repro/`, the bundle beside it, and,
// given a framework checkout, every `@ultimat3/*` linked to that checkout's source (`file:`).

// why: Bun has no synchronous existence check for a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { isAbsolute, join, resolve } from 'node:path';
import type { CommandResult, CommandSpec } from '@ultimat3/cli';
import {
  BadFlagError,
  BUNDLE_FORMAT,
  flagString,
  frameworkCheckoutFrom,
  frameworkOverrides,
  isFrameworkCheckout,
  msg,
  PLACEHOLDER_DB_MODULE,
  parseArgs,
  quoteArg,
  ReproBundleInvalidError,
  writeNewApp,
} from '@ultimat3/cli';

export const reproSpec: CommandSpec = {
  name: 'repro',
  summary: 'open an x repro --bundle file into a scratch app',
  usage: 'bunx create-ultimate repro <bundle.json> [--dir parent] [--framework checkout] [--json]',
  flags: [
    { name: 'dir', type: 'string', summary: 'parent directory (default: cwd)' },
    {
      name: 'framework',
      type: 'string',
      summary: 'a framework checkout to link (default: the one cwd is inside, if any)',
    },
  ],
};

interface Bundle {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly versions: string;
  readonly file: string;
  readonly source: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const refuse = (path: string, reason: string): ReproBundleInvalidError =>
  new ReproBundleInvalidError({ path, reason });

/** The bundle's facts this opener needs, or a refusal naming what is missing. */
async function readBundle(path: string): Promise<Bundle> {
  if (!(await Bun.file(path).exists())) throw refuse(path, 'no file is there');
  const parsed: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined);
  if (!isRecord(parsed) || parsed['format'] !== BUNDLE_FORMAT) {
    throw refuse(path, `its format is not ${BUNDLE_FORMAT}`);
  }
  const { reproducer, subject, framework } = parsed;
  const source = isRecord(reproducer) ? reproducer['source'] : undefined;
  const file = isRecord(reproducer) ? reproducer['file'] : undefined;
  const lines = Array.isArray(source) ? source.filter((line) => typeof line === 'string') : [];
  // The file name is written into the scratch app: one segment under `repro/`, nothing that climbs.
  if (
    typeof file !== 'string' ||
    !/^repro\/[a-z0-9.-]+\.test\.ts$/.test(file) ||
    lines.length === 0
  ) {
    throw refuse(path, 'it carries no reproducer test under repro/');
  }
  const packages =
    isRecord(framework) && isRecord(framework['packages']) ? framework['packages'] : {};
  const versions = [...new Set(Object.values(packages).flat())].join(', ') || 'unknown versions';
  return {
    id: typeof parsed['id'] === 'string' ? parsed['id'] : 'unnamed',
    code: typeof parsed['code'] === 'string' ? parsed['code'] : 'an uncoded failure',
    name:
      isRecord(subject) && typeof subject['name'] === 'string'
        ? subject['name']
        : 'the failing primitive',
    versions,
    file,
    source: lines.join('\n'),
  };
}

export async function openRepro(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const args = parseArgs(argv, [reproSpec]);
  const bundlePath = resolve(cwd, args.positionals[0] ?? '');
  const bundle = await readBundle(bundlePath);
  const dirFlag = flagString(args, 'dir');
  const parent = dirFlag === undefined ? cwd : isAbsolute(dirFlag) ? dirFlag : join(cwd, dirFlag);
  const short =
    bundle.id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12) || 'unnamed';
  const name = `repro-${short}`;
  const dir = join(parent, name);
  if (existsSync(dir)) {
    throw new BadFlagError({
      flag: 'dir',
      command: 'repro',
      reason: `${dir} already exists`,
      fix: `bunx create-ultimate repro ${quoteArg(bundlePath)} --dir <another parent>`,
    });
  }
  const frameworkFlag = flagString(args, 'framework');
  const checkout =
    frameworkFlag === undefined ? frameworkCheckoutFrom(cwd) : resolve(cwd, frameworkFlag);
  if (checkout !== undefined && !isFrameworkCheckout(checkout)) {
    throw new BadFlagError({
      flag: 'framework',
      command: 'repro',
      reason: `${checkout} has no packages/core named @ultimat3/core`,
      fix: `git clone https://github.com/developerz-ai/ultimate, then bunx create-ultimate repro ${quoteArg(bundlePath)} --framework ultimate`,
    });
  }
  await writeNewApp(dir, { name, example: false });
  await Bun.write(
    join(dir, bundle.file),
    bundle.source.replaceAll(`'${PLACEHOLDER_DB_MODULE}'`, `'@${name}/db'`),
  );
  await Bun.write(join(dir, 'repro', 'bundle.json'), Bun.file(bundlePath));
  const lines: string[] = [];
  if (checkout === undefined) lines.push(msg('cli.repro.openedRegistry'));
  else {
    const pkgPath = join(dir, 'package.json');
    const pkg: unknown = await Bun.file(pkgPath).json();
    const base = isRecord(pkg) ? pkg : {};
    const prior = isRecord(base['overrides']) ? base['overrides'] : {};
    const overrides = { ...prior, ...(await frameworkOverrides(checkout)) };
    await Bun.write(pkgPath, `${JSON.stringify({ ...base, overrides }, null, 2)}\n`);
    lines.push(
      msg('cli.repro.openedFramework', { framework: checkout, versions: bundle.versions }),
    );
  }
  lines.push(msg('cli.repro.openedStandIn', { name: bundle.name }));
  lines.push(msg('cli.repro.openedNext', { dir: quoteArg(dir), file: bundle.file }));
  return {
    ok: true,
    command: 'repro',
    summary: msg('cli.repro.opened', { code: bundle.code, bundle: bundlePath, dir }),
    lines,
    data: { dir, file: bundle.file, framework: checkout ?? null, bundle: bundlePath },
  };
}
