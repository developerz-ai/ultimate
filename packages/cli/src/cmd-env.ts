// `x env` — the two things a typed environment owes an agent: the committed `.env.example` that
// says which variables exist, and the answer to "does this process have them?". Both are
// projections of the one `defineEnv` declaration in `app.config.ts`; neither reads a second list.

// Bun ships no path-join primitive, and `.env.example` is written app-root-relative.
import { join } from 'node:path';
import {
  checkEnv,
  ENV_EXAMPLE_PATH,
  ERROR_DOCS_URL,
  maskedEnvValues,
  UltimateError,
} from '@ultimat3/core';
import { envExampleFor, loadEnvSchema } from './app-env';
import { requireAppRoot } from './app-root';
import { envSpec } from './cmd-env-spec';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';

/**
 * `x env` was run in an app whose `app.config.ts` exports no `envSchema`. Not a silent success:
 * writing a `.env.example` with no variables in it, or reporting "0 declared variables, all
 * present", both read as a working environment declaration to whoever runs the command next.
 *
 * `X_CONFIG_INVALID` is core's code for "a configuration this process cannot boot on — env or
 * `app.config.ts`", which is exactly this; the CLI names it in `CLI_BORROWED_ERROR_CODES` rather
 * than minting a synonym.
 */
export class EnvSchemaMissingError extends UltimateError {
  constructor(input: { subcommand: string }) {
    super({
      code: 'X_CONFIG_INVALID',
      cause: `x env ${input.subcommand} needs the env declaration, and app.config.ts exports no "envSchema"`,
      fix: "add to app.config.ts: export const envSchema = { DATABASE_URL: { type: 'url', description: 'Postgres connection URL' } } satisfies EnvSchema; export const env = defineEnv(envSchema);",
    });
  }
}

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
    docs: ERROR_DOCS_URL,
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
  spec: envSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    // `subcommand`, never `positionals[0]`: the parser has already lifted a declared subcommand
    // out of the positionals, so reading the array here matches nothing and every invocation
    // silently ran the default.
    return (ctx.args.subcommand ?? 'check') === 'example'
      ? writeExample(ctx)
      : checkProcessEnv(ctx);
  },
};
