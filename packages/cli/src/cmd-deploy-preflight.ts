// What `x deploy --method compose` checks before its first step, and what it reads after a failed
// one. Before: `.env.production` exists and sets every `${VAR:?}` the compose file demands —
// without it each step died as `role "migrate" step exited 1`. After: the role's last log line.

// why: Bun ships no path-join primitive; the env file is app-root-relative.
import { join } from 'node:path';
import type { EnvSchema } from '@ultimat3/core';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { composeRequiredVars } from './cmd-deploy-compose';
import { requiredAtBoot } from './env-production';
import type { ExecOptions, Runner } from './exec';
import type { Finding } from './output';
import { parseDotenv } from './root-env';
import { PROD_ENV_FILE } from './templates/scaffold-container-compose';

type EnvTable = Readonly<Record<string, string | undefined>>;

const missingFinding = (cause: string): Finding => ({
  code: 'X_DEPLOY_ENV_MISSING',
  cause,
  fix: 'x env init --production --json',
  docs: ERROR_DOCS_URL,
  at: PROD_ENV_FILE,
});

/**
 * The refusal, or `undefined` when every step can parse the compose file and every role can boot.
 * A compose variable counts as set from the shell too — compose reads it there first; a key the
 * app's `envSchema` requires reaches the containers through `env_file:` alone, so only the file
 * counts for it. Empty is as absent as none: `${VAR:?}` and the boot's env check refuse both.
 */
export async function composeEnvPreflight(
  root: string,
  compose: string | undefined,
  shell: EnvTable,
  schema: EnvSchema = {},
): Promise<Finding | undefined> {
  const file = Bun.file(join(root, PROD_ENV_FILE));
  if (!(await file.exists())) {
    return missingFinding(
      `${PROD_ENV_FILE} does not exist, and every compose step reads it (--env-file and env_file:)`,
    );
  }
  const values = parseDotenv(await file.text());
  const interpolated = (compose === undefined ? [] : composeRequiredVars(compose)).filter(
    (key) => (shell[key] ?? values.get(key) ?? '') === '',
  );
  const declared = Object.entries(schema)
    .filter(([key, decl]) => requiredAtBoot(decl) && (values.get(key) ?? '') === '')
    .map(([key]) => key)
    .filter((key) => !interpolated.includes(key));
  const missing = [...interpolated, ...declared];
  if (missing.length === 0) return undefined;
  return {
    ...missingFinding(
      `${PROD_ENV_FILE} leaves ${missing.join(', ')} unset or empty, and ${missing.length === 1 ? 'it is' : 'each is'} required: by docker/docker-compose.prod.yml (\${VAR:?}) or by app.config.ts's envSchema, which every role checks at boot`,
    ),
    // The file exists, so the generator would refuse it: the edit is the fix.
    fix: `NODE_ENV=production x env check --json   # after setting ${missing.join(', ')} in ${PROD_ENV_FILE}`,
  };
}

/** A rendered `UltimateError`: `X_CODE: title — cause`. A JSON log's `"code":"X_…"` is not one. */
const RENDERED_CODE = /\bX_[A-Z][A-Z0-9_]*: /;

/** Bun's trailer after an uncaught error, the last line of every crash and never its reason. */
const BUN_TRAILER = /^Bun v\d+\.\d+/;

/** The longest line a finding carries: the reason fits, a stack-sized blob does not. */
const LINE_CEILING = 500;

/**
 * The line that says why a process failed: the last rendered `X_*` refusal, else the last
 * non-empty line that is not Bun's version trailer. stderr first, where a refusal is written.
 */
export function lastLine(output: { readonly stdout: string; readonly stderr: string }): string {
  for (const text of [output.stderr, output.stdout]) {
    const lines = text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const line =
      lines.findLast((entry) => RENDERED_CODE.test(entry)) ??
      lines.findLast((entry) => !BUN_TRAILER.test(entry));
    if (line !== undefined) return line.slice(0, LINE_CEILING);
  }
  return '';
}

/**
 * A serving role's last log line, read after its step failed: a crash-looping container says why
 * in its log, and `up -d` itself only says that it did not become healthy. Empty when compose
 * cannot read the log either; the finding then carries the rerun command alone.
 */
export async function roleLastLogLine(input: {
  readonly base: readonly string[];
  readonly role: string;
  readonly runner: Runner;
  readonly options: ExecOptions;
}): Promise<string> {
  const command = [
    ...input.base,
    'logs',
    '--no-color',
    '--no-log-prefix',
    '--tail',
    '50',
    input.role,
  ];
  try {
    const result = await input.runner(command, input.options);
    return result.ok ? lastLine(result) : '';
  } catch {
    // The log is a courtesy on a failure already being reported; a runner that cannot spawn
    // compose here must not replace that report with its own.
    return '';
  }
}
