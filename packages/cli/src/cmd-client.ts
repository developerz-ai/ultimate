// `x client` — one OpenAPI compiler, two emitters. `vendor <name>` compiles a third party's
// document into `apps/web/clients/<name>/` (outbound() and `t` schemas); `customer --out <dir>`
// compiles the app's own published document into a client with no framework import at all.
//
// CLI wiring only: the compiler is `openapi-compile.ts`, the bytes are `client-emit-*.ts`.

// why: Bun ships no path-join primitive.
import { isAbsolute, join } from 'node:path';
import { requireAppRoot } from './app-root';
import { readStamp, stamped } from './client-emit-header';
import { emitVendor } from './client-emit-vendor';
import { runCustomer } from './cmd-client-customer';
import { readClientSource, sourceHash } from './cmd-client-source';
import { clientSpec } from './cmd-client-spec';
import { CLIENTS_DIR, compileOrRefuse, writeFiles } from './cmd-client-write';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagList, flagString } from './parse';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';

const VENDOR_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** `--only`, or — on a regeneration that passes none — the tags the client was generated with. */
async function onlyFor(
  ctx: CommandContext,
  existing: string,
): Promise<readonly string[] | undefined> {
  const given = flagList(ctx.args, 'only');
  if (given.length > 0) return given;
  const file = Bun.file(existing);
  if (!(await file.exists())) return undefined;
  const stamp = readStamp(await file.text())?.stamp;
  const kept = stamp === undefined ? undefined : /(?:^| )--only (\S+)/.exec(stamp.command)?.[1];
  return kept === undefined ? undefined : kept.split(',').filter((tag) => tag.length > 0);
}

async function runVendor(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot('client vendor', ctx.cwd).dir;
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new MissingPositionalError({
      command: 'client vendor',
      positional: 'name',
      example: 'x client vendor billing --from ./openapi.json --json',
    });
  }
  if (!VENDOR_NAME.test(name)) {
    throw new BadFlagError({
      flag: 'name',
      command: 'client vendor',
      reason: `${quoteArg(name)} is not a lower-case slug (a-z, 0-9, -), so it cannot name a directory and a vendor label`,
      fix: 'x client vendor billing --from ./openapi.json --json',
    });
  }
  const dir = `${CLIENTS_DIR}/${name}`;
  const committed = `${dir}/source.json`;
  const fromFlag = flagString(ctx.args, 'from');
  const from =
    fromFlag === undefined || isAbsolute(fromFlag) || /^https?:/.test(fromFlag)
      ? fromFlag
      : posixRelative(root, join(ctx.cwd, fromFlag));
  const source = await readClientSource({ from: fromFlag, cwd: ctx.cwd, root, committed, name });
  const only = await onlyFor(ctx, join(root, dir, 'client.ts'));
  const compiled = compileOrRefuse(source.document, from ?? committed, only, 'client vendor');
  const emitted = emitVendor(name, compiled);
  const stamp = {
    command: `x client vendor ${name}${only === undefined ? '' : ` --only ${only.join(',')}`}`,
    source: committed,
    sourceHash: sourceHash(source.document),
  };
  const written = await writeFiles(
    root,
    new Map([
      [committed, source.text],
      [`${dir}/schemas.ts`, stamped(stamp, emitted['schemas.ts'])],
      [`${dir}/client.ts`, stamped(stamp, emitted['client.ts'])],
    ]),
  );
  return {
    ok: true,
    command: 'client',
    summary: msg('cli.client.vendor.written', {
      name,
      operations: compiled.operations.length,
      types: compiled.types.size,
      source: from ?? committed,
      dir,
    }),
    lines: written.map((path) => msg('cli.client.file', { path })),
    data: {
      kind: 'vendor',
      name,
      dir,
      source: committed,
      only: only === undefined ? null : [...only],
      operations: compiled.operations.map((op) => op.name),
      types: compiled.types.size,
      written: [...written],
    },
  };
}

export const clientCommand: CliCommand = {
  spec: clientSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    return ctx.args.subcommand === 'customer' ? runCustomer(ctx) : runVendor(ctx);
  },
};
