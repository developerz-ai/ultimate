// `create-ultimate repro <bundle.json>`: a bug's `x repro --bundle` file, opened into a scratch app.
// The bundle is a stranger's data: only its `subject` is read (parsed field by field) and the test
// is REBUILT from it — the bundle's own `reproducer` text never reaches disk. Given a framework
// checkout, every `@ultimat3/*` is linked to that checkout's source (`file:`).

// why: Bun has no synchronous existence check for a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { isAbsolute, join, resolve } from 'node:path';
import type { CommandResult, CommandSpec } from '@ultimat3/cli';
import {
  BadFlagError,
  BUNDLE_FORMAT,
  bundleReproducer,
  flagString,
  frameworkCheckoutFrom,
  frameworkOverrides,
  isFrameworkCheckout,
  msg,
  parseArgs,
  parseReproSubject,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The bundle's subject, checked, and the versions it was made on (prose only, never code). */
async function readBundle(path: string) {
  if (!(await Bun.file(path).exists())) {
    throw new ReproBundleInvalidError({ path, reason: 'no file is there' });
  }
  const parsed: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined);
  if (!isRecord(parsed) || parsed['format'] !== BUNDLE_FORMAT) {
    throw new ReproBundleInvalidError({ path, reason: `its format is not ${BUNDLE_FORMAT}` });
  }
  const subject = parseReproSubject(parsed['subject']);
  if (subject === undefined) {
    throw new ReproBundleInvalidError({
      path,
      reason: 'its subject is not a failure x repro reads',
    });
  }
  const framework = parsed['framework'];
  const packages =
    isRecord(framework) && isRecord(framework['packages']) ? framework['packages'] : {};
  const versions = [...new Set(Object.values(packages).flat())]
    .filter((version): version is string => typeof version === 'string')
    .filter((version) => /^[\w.+-]{1,40}$/.test(version))
    .join(', ');
  return { subject, versions: versions || 'unknown versions' };
}

export async function openRepro(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const args = parseArgs(argv, [reproSpec]);
  const bundlePath = resolve(cwd, args.positionals[0] ?? '');
  const { subject, versions } = await readBundle(bundlePath);
  const dirFlag = flagString(args, 'dir');
  const parent = dirFlag === undefined ? cwd : isAbsolute(dirFlag) ? dirFlag : join(cwd, dirFlag);
  const id =
    subject.kind === 'job'
      ? subject.failure.jobId
      : (subject.bundle.requestId ?? subject.bundle.id);
  const short =
    id
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
  const reproducer = bundleReproducer(subject, `@${name}/db`);
  await Bun.write(join(dir, reproducer.file), reproducer.source.join('\n'));
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
    lines.push(msg('cli.repro.openedFramework', { framework: checkout, versions }));
  }
  const failing = subject.kind === 'job' ? subject.failure : subject.bundle;
  lines.push(msg('cli.repro.openedStandIn', { name: failing.name }));
  lines.push(msg('cli.repro.openedNext', { dir: quoteArg(dir), file: reproducer.file }));
  return {
    ok: true,
    command: 'repro',
    summary: msg('cli.repro.opened', {
      code: failing.code ?? 'an uncoded failure',
      bundle: bundlePath,
      dir,
    }),
    lines,
    data: { dir, file: reproducer.file, framework: checkout ?? null, bundle: bundlePath },
  };
}
