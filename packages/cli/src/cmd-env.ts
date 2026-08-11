// `x env` — the two things a typed environment owes an agent: the committed `.env.example` that
// says which variables exist, and the answer to "does this process have them?". Both are
// projections of the one `defineEnv` declaration in `app.config.ts`; neither reads a second list.

// Bun ships no path-join primitive, and `.env.example` is written app-root-relative.
import { join } from 'node:path';
import { checkEnv, ENV_EXAMPLE_PATH, maskedEnvValues } from '@ultimat3/core';
import { ENV_SCHEMA_EXPORT, envExampleFor, loadEnvSchema } from './app-env';
import { APP_CONFIG_FILE, requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { EnvSchemaMissingError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';

/**
 * Every subcommand needs the declaration, and an app without one is a usage error rather than an
 * empty success: `x env example` writing a two-comment file would look like it worked.
 */
async function requireSchema(cwd: string, subcommand: string) {
  const root = requireAppRoot(`env ${subcommand}`, cwd).dir;
  const schema = await loadEnvSchema(root);
  if (schema === undefined) throw new EnvSchemaMissingError({ subcommand });
  return { root, schema };
}

async function writeExample(ctx: CommandContext): Promise<CommandResult> {
  const { root, schema } = await requireSchema(ctx.cwd, 'example');
  const contents = envExampleFor(schema);
  const path = join(root, ENV_EXAMPLE_PATH);
  const file = Bun.file(path);
  const fresh = (await file.exists()) && (await file.text()) === contents;
  if (!fresh) await Bun.write(path, contents);
  const count = Object.keys(schema).length;
  return {
    ok: true,
    command: 'env',
    summary: fresh
      ? msg('cli.env.fresh', { path: ENV_EXAMPLE_PATH })
      : msg('cli.env.wrote', { path: ENV_EXAMPLE_PATH, count }),
    data: { path: ENV_EXAMPLE_PATH, variables: count, written: !fresh },
  };
}

/**
 * The values are read from the real process environment, and only ever printed through
 * `maskedEnvValues` — `checkEnv().values` holds the actual secrets because `defineEnv()` has to
 * return them, and a `--json` report is the last place a DSN should appear in full.
 */
async function checkProcessEnv(ctx: CommandContext): Promise<CommandResult> {
  const { schema } = await requireSchema(ctx.cwd, 'check');
  const report = checkEnv(schema);
  const total = Object.keys(schema).length;
  const findings: readonly Finding[] = report.issues.map((issue) => ({
    code: 'X_ENV_MISSING',
    cause: `${issue.key} is ${issue.reason} (expected ${issue.expected})`,
    fix: issue.fix,
    docs: 'https://ultimate.dev/errors/X_ENV_MISSING',
    at: ENV_EXAMPLE_PATH,
  }));
  return {
    ok: report.ok,
    command: 'env',
    summary: report.ok
      ? msg('cli.env.checked', { count: total })
      : msg('cli.env.invalid', { count: report.issues.length, total }),
    findings,
    data: {
      variables: total,
      values: maskedEnvValues(schema, report.values) as JsonValue,
    },
    exitCode: report.ok ? 0 : 1,
  };
}

export const envCommand: CliCommand = {
  spec: {
    name: 'env',
    summary: `the typed environment declared by ${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE}`,
    usage: 'x env [check|example] [--json]',
    requiresApp: true,
    // `check` is first, so the bare `x env` answers the question the fix line on every
    // `X_ENV_MISSING` in this framework already tells its reader to run.
    subcommands: ['check', 'example'],
    flags: [],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    // `subcommand`, never `positionals[0]`: the parser has already lifted a declared subcommand
    // out of the positionals, so reading the array here matches nothing and every invocation
    // silently ran the default.
    return (ctx.args.subcommand ?? 'check') === 'example'
      ? writeExample(ctx)
      : checkProcessEnv(ctx);
  },
};
