// `x client customer` — the app's own published document (`openapi.json`, or a bearer mount's
// declared file) compiled into a client a customer's TypeScript imports with no framework on its
// path. Read from the COMMITTED file: what a customer is handed, and what `drift` hashes back.

// why: Bun ships no path-join primitive.
import { isAbsolute, join } from 'node:path';
import { apiDeclaration } from '@ultimat3/action';
import { loadApp } from './app-load';
import { OPENAPI_FILE } from './app-openapi';
import { requireAppRoot } from './app-root';
import { emitCustomer } from './client-emit-customer';
import { stamped } from './client-emit-header';
import { parseSource, sourceHash } from './cmd-client-source';
import { compileOrRefuse, writeFiles } from './cmd-client-write';
import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagList, flagString } from './parse';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';

const COMMAND = 'client customer';

/** The document's file: `openapi.json`, or the one a `--mount` declares as its own. */
function documentFile(mount: string | undefined): string {
  if (mount === undefined) return OPENAPI_FILE;
  const mounts = apiDeclaration().http?.mounts ?? [];
  const found = mounts.find((candidate) => candidate.prefix === mount);
  if (found === undefined) {
    throw new BadFlagError({
      flag: 'mount',
      command: COMMAND,
      reason: `no bearer mount has the prefix ${quoteArg(mount)} (declared: ${mounts.map((m) => m.prefix).join(', ') || 'none'})`,
      fix: 'x routes --json   # every mounted path; pass one of the declared prefixes',
    });
  }
  if (found.openapi === undefined) {
    throw new BadFlagError({
      flag: 'mount',
      command: COMMAND,
      reason: `the mount ${quoteArg(mount)} declares no openapi file, so it publishes no document a client can be checked against`,
      fix: `x manifest --json   # after adding openapi: 'openapi${mount.replace(/\//g, '.')}.json' to that mount in apps/web/api/index.ts`,
    });
  }
  return found.openapi;
}

/** `{ name, version, exports }` — nothing a registry publish would need us to decide. */
const packageJson = (name: string, version: string): string =>
  `${JSON.stringify(
    {
      name,
      version,
      type: 'module',
      exports: { '.': './index.ts', './types': './types.ts' },
      files: ['index.ts', 'types.ts'],
    },
    null,
    2,
  )}\n`;

export async function runCustomer(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot(COMMAND, ctx.cwd).dir;
  const outFlag = flagString(ctx.args, 'out');
  if (outFlag === undefined) {
    throw new BadFlagError({
      flag: 'out',
      command: COMMAND,
      reason: 'names no directory to write the client into',
      fix: 'x client customer --out apps/web/clients/customer --json',
    });
  }
  const out = posixRelative(root, isAbsolute(outFlag) ? outFlag : join(ctx.cwd, outFlag)) || '.';
  const mount = flagString(ctx.args, 'mount');
  const only = flagList(ctx.args, 'only');
  const packageName = flagString(ctx.args, 'package');
  // A mount's file is the app's declaration, so the app is loaded to read it; the plain document
  // is `openapi.json` by definition and needs no load.
  if (mount !== undefined) await loadApp(root);
  const file = documentFile(mount);
  const committed = Bun.file(join(root, file));
  if (!(await committed.exists())) {
    throw new BadFlagError({
      flag: mount === undefined ? 'out' : 'mount',
      command: COMMAND,
      reason: `${file} has not been written, so there is no published document to compile`,
      fix: 'x manifest --json',
    });
  }
  const { document } = parseSource(await committed.text(), file);
  const compiled = compileOrRefuse(document, file, only.length === 0 ? undefined : only, COMMAND);
  const emitted = emitCustomer(compiled);
  const flags = [
    `--out ${quoteArg(out)}`,
    ...(mount === undefined ? [] : [`--mount ${quoteArg(mount)}`]),
    ...(only.length === 0 ? [] : [`--only ${only.join(',')}`]),
    ...(packageName === undefined ? [] : [`--package ${quoteArg(packageName)}`]),
  ];
  const stamp = {
    command: `x client customer ${flags.join(' ')}`,
    source: file,
    sourceHash: sourceHash(document),
  };
  const files = new Map([
    [`${out}/types.ts`, stamped(stamp, emitted['types.ts'])],
    [`${out}/index.ts`, stamped(stamp, emitted['index.ts'])],
  ]);
  if (packageName !== undefined) {
    files.set(`${out}/package.json`, packageJson(packageName, compiled.version));
  }
  const written = await writeFiles(root, files);
  return {
    ok: true,
    command: 'client',
    summary: msg('cli.client.customer.written', {
      operations: compiled.operations.length,
      types: compiled.types.size,
      source: file,
      dir: out,
    }),
    lines: written.map((path) => msg('cli.client.file', { path })),
    data: {
      kind: 'customer',
      dir: out,
      source: file,
      mount: mount ?? null,
      only: only.length === 0 ? null : [...only],
      operations: compiled.operations.map((op) => op.name),
      types: compiled.types.size,
      written: [...written],
    },
  };
}
