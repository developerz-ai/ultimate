// The one seam between the CLI and the `gh` binary. Every GitHub call is built here and spawned
// through the injected `Runner`, so a test asserts the exact argv with no network and no `gh`
// installed — and the four ways this shell-out fails (no binary, no credentials, a non-zero exit,
// an answer that will not parse) each get one code and one executable fix instead of a stack trace.

import { renderThrowable, singleLine, UltimateError } from '@ultimat3/core';
import type { AnySchema, InferOutput } from '@ultimat3/schema';
import { formatPath } from '@ultimat3/schema';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';

/** What a gh call needs from a `CommandContext`, and nothing more — so a test passes two fields. */
export interface GhHost {
  readonly runner: Runner;
  readonly cwd: string;
}

export interface GhOptions {
  /**
   * A short name for this call. Every refusal is titled with it rather than with the argv,
   * because a GraphQL document pasted into a `cause:` is a page of text where a reader needs a
   * sentence.
   */
  readonly label: string;
  /**
   * The caller's remedy, and REQUIRED: the seam knows a call failed and never what the operator
   * was trying to do, so a generic fix here would be axiom 4 inverted at the one boundary every
   * GitHub call crosses. Making it a field of the options is what turns "state a remedy" into a
   * build error rather than a convention.
   */
  readonly fix: string;
}

/** The one binary this file spawns. Named once, so every argv assertion has a single source. */
export const GH_BIN = 'gh';

/**
 * No `gh` on PATH. `exec.ts` already refuses a missing program with `X_CLI_UNEXPECTED`, and that
 * code's fix names the binary — but "the CLI itself failed" is the wrong sentence for a machine
 * that simply has no GitHub client, and `gh auth login` is not reachable from it.
 */
export class GhUnavailableError extends UltimateError {
  constructor(input: { cwd: string; detail: string }) {
    super({
      code: 'X_GH_UNAVAILABLE',
      cause: `the GitHub CLI could not be run from ${input.cwd}: ${input.detail}`,
      fix: 'install the GitHub CLI from https://cli.github.com, then run: gh auth login',
    });
  }
}

/** `gh` is installed and holds no usable credentials for this host. One command closes it. */
export class GhNotAuthenticatedError extends UltimateError {
  constructor(input: { label: string; detail: string }) {
    super({
      code: 'X_GH_NOT_AUTHENTICATED',
      cause: `${input.label} was refused by GitHub: ${input.detail}`,
      fix: 'gh auth login',
    });
  }
}

/** Any other non-zero exit — a bad id, a repository that is not there, a rate limit. */
export class GhFailedError extends UltimateError {
  constructor(input: { label: string; code: number; detail: string; fix: string }) {
    super({
      code: 'X_GH_COMMAND_FAILED',
      cause: `${input.label} exited ${input.code}: ${input.detail}`,
      fix: input.fix,
    });
  }
}

/**
 * `gh` answered, and the answer is not the shape this command reads. A cast would carry the
 * mismatch into the render and print `undefined` at whichever field moved; the parse refuses at
 * the boundary instead, which is the only place the argv that produced it is still known.
 */
export class GhResponseInvalidError extends UltimateError {
  constructor(input: { label: string; detail: string; fix: string }) {
    super({
      code: 'X_GH_RESPONSE_INVALID',
      cause: `${input.label} answered something this command cannot read: ${input.detail}`,
      fix: input.fix,
    });
  }
}

/**
 * The spellings `gh` uses when the token is the problem. Matched against its own output rather
 * than against an exit code, because every one of these exits 1 exactly like a typo'd id does —
 * and the two have different remedies.
 */
const UNAUTHENTICATED =
  /not logged in|gh auth login|HTTP 401|Bad credentials|GH_TOKEN|GITHUB_TOKEN|authentication/i;

/** The first line a human would read, escaped and bounded — a `cause:` is one line by contract. */
export function ghDetail(result: ExecResult): string {
  const merged = execOutput(result);
  const first = merged.split('\n').find((line) => line.trim().length > 0) ?? '';
  const text = singleLine(first.trim().replace(/^gh:\s*/, ''));
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * One `gh` invocation, refused four ways. A spawn failure is mapped rather than rethrown: it is
 * the "no GitHub CLI on this machine" case, and `exec.ts`'s own refusal cannot offer `gh auth
 * login` as the next step.
 */
export async function runGh(
  host: GhHost,
  args: readonly string[],
  options: GhOptions,
): Promise<ExecResult> {
  let result: ExecResult;
  try {
    result = await host.runner([GH_BIN, ...args], { cwd: host.cwd });
  } catch (error) {
    // Never interpolated: the thrown value is genuinely unknown here (Bun raises `ENOENT` for a
    // missing program and `EACCES` for an unrunnable one), which is what `bun run error-render`
    // refuses to see reach a `cause:` through `${…}`.
    throw new GhUnavailableError({ cwd: host.cwd, detail: renderThrowable(error) });
  }
  if (result.ok) return result;
  const detail = ghDetail(result);
  if (UNAUTHENTICATED.test(detail)) {
    throw new GhNotAuthenticatedError({ label: options.label, detail });
  }
  throw new GhFailedError({ label: options.label, code: result.code, detail, fix: options.fix });
}

/**
 * `gh --json`, parsed rather than cast. The response is untrusted input — a different `gh`
 * version, a proxy that answered HTML, a field GitHub renamed — so it goes through the schema the
 * caller declared and a mismatch is a coded refusal naming the call that produced it.
 */
export async function ghJson<S extends AnySchema>(
  host: GhHost,
  args: readonly string[],
  schema: S,
  options: GhOptions,
): Promise<InferOutput<S>> {
  const result = await runGh(host, args, options);
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new GhResponseInvalidError({
      label: options.label,
      detail: renderThrowable(error),
      fix: options.fix,
    });
  }
  const parsed = schema.safeParse(payload);
  if (parsed.issues !== undefined) {
    const first = parsed.issues[0];
    // `formatPath` is the schema package's own renderer for an issue path — a second spelling of
    // `items[0].price` here would be a field name that does not match the one every other
    // validation failure in the framework prints.
    throw new GhResponseInvalidError({
      label: options.label,
      detail:
        first === undefined
          ? 'the response matched no field this command declares'
          : `${formatPath(first.path)} ${first.message}`.trim(),
      fix: options.fix,
    });
  }
  return parsed.value as InferOutput<S>;
}

/**
 * A GraphQL call, and the two `gh` field flags are not interchangeable — the type of the variable
 * decides which one is correct, so the type of the value decides here.
 *
 * A **string** rides as `-f`, never `-F`: `-F` reads `@file` as "load this from disk", so a review
 * reply whose body begins with an `@` would post the contents of a local file. A **number** has to
 * ride as `-F`, because `-f` sends every value as a GraphQL `String` and a `$n:Int!` parameter
 * refuses one (measured: `gh api graphql … -f n=238` against `Int!` is a `variableNotUsed`/type
 * error, `-F n=238` succeeds). `-F` is safe for a number precisely because a number can never
 * spell `@file`.
 *
 * The caller's schema describes the WHOLE envelope (`{ data: … }`) rather than its inside: gh
 * exits non-zero whenever the response carries `errors`, so a partial answer never reaches here,
 * and a caller that spells out the envelope keeps every nullable GitHub returns visible.
 */
export async function ghGraphql<S extends AnySchema>(
  host: GhHost,
  document: string,
  variables: Readonly<Record<string, string | number>>,
  schema: S,
  options: GhOptions,
): Promise<InferOutput<S>> {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${document}`,
    ...Object.entries(variables).flatMap(([name, value]) =>
      typeof value === 'number' ? ['-F', `${name}=${value}`] : ['-f', `${name}=${value}`],
    ),
  ];
  return ghJson(host, args, schema, options);
}
