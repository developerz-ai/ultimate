// `x deploy verify`'s flags, read and refused before anything is sampled: every value the wait could
// not use is an `X_CLI_BAD_FLAG` here, never a red run minutes later.

// why: Bun exposes no path-join primitive; the manifest sits at the app root.
import { join } from 'node:path';
import { renderCauseValue, stringField } from '@ultimat3/core';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { parseDuration } from '@ultimat3/time';
import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import { flagList, flagString } from './parse';

export const VERIFY_COMMAND = 'deploy verify';
const EXAMPLE = 'x deploy verify --url https://app.example.com --json';
const DEFAULT_WINDOW = '60s';
const DEFAULT_INTERVAL = '5s';
const DEFAULT_TIMEOUT = '10m';

/**
 * `@ultimat3/time`'s `parseDuration`, the grammar a job's `timeout: '1d'` is read with, so a flag
 * never refuses a value a declaration accepts. Bare `0` where the flag can mean none; a negative or
 * a zero where it cannot is refused here, because a wait of nothing is not a wait.
 */
export function readDuration(
  raw: string,
  flag: { readonly flag: string; readonly zero: boolean },
): number {
  const ms = raw.trim() === '0' ? 0 : parsedOrNaN(raw);
  if (ms >= 0 && (flag.zero || ms > 0)) return ms;
  throw new BadFlagError({
    flag: flag.flag,
    command: VERIFY_COMMAND,
    reason: `${renderCauseValue(raw)} is not a ${flag.zero ? '' : 'positive '}duration such as 60s, 10m, 1d or PT1H`,
    fix: EXAMPLE,
  });
}

/** `NaN` for anything `parseDuration` refuses: the flag's own refusal above names the flag. */
function parsedOrNaN(raw: string): number {
  try {
    return parseDuration(raw);
  } catch {
    return Number.NaN;
  }
}

/**
 * The origin, and only that: `/readyz` lives at the root, so a path would be silently dropped, and
 * credentials would ride into every log line that names the URL. The cause never echoes the value.
 */
function readOrigin(raw: string | undefined): string {
  const refuse = (reason: string): BadFlagError =>
    new BadFlagError({ flag: 'url', command: VERIFY_COMMAND, reason, fix: EXAMPLE });
  if (raw === undefined) throw refuse('it is required: the origin the load balancer answers on');
  const parsed = URL.canParse(raw) ? new URL(raw) : undefined;
  if (parsed === undefined || !['http:', 'https:'].includes(parsed.protocol)) {
    throw refuse('it must be an http or https origin');
  }
  if (parsed.href !== `${parsed.origin}/`) {
    throw refuse('it must be a bare origin: no path, query, fragment or credentials');
  }
  return parsed.origin;
}

/** `--build`, else the manifest's: what `x build --target docker` stamped when CI stamped nothing. */
export async function readBuild(ctx: CommandContext, root: string): Promise<string> {
  const given = flagString(ctx.args, 'build');
  if (given !== undefined && given.trim() !== '') return given;
  const file = Bun.file(join(root, MANIFEST_FILENAME));
  // A manifest that is not JSON is one that names no build: refused below, never a raw SyntaxError.
  const manifest: unknown = (await file.exists())
    ? await file.json().catch(() => undefined)
    : undefined;
  const buildId = stringField(manifest, 'buildId');
  if (typeof buildId === 'string' && buildId !== '') return buildId;
  throw new BadFlagError({
    flag: 'build',
    command: VERIFY_COMMAND,
    reason: `not given, and ${MANIFEST_FILENAME} names no buildId`,
    fix: 'x deploy verify --url https://app.example.com --build "$BUILD_ID" --json',
  });
}

export interface VerifyOptions {
  readonly origin: string;
  readonly windowMs: number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly idleOk: readonly string[];
}

export function readOptions(ctx: CommandContext): VerifyOptions {
  const duration = (flag: string, fallback: string, zero = false): number =>
    readDuration(flagString(ctx.args, flag) ?? fallback, { flag, zero });
  const origin = readOrigin(flagString(ctx.args, 'url'));
  const windowMs = duration('window', DEFAULT_WINDOW, true);
  const intervalMs = duration('interval', DEFAULT_INTERVAL);
  const timeoutMs = duration('timeout', DEFAULT_TIMEOUT);
  // A window the wait can never hold is a red run whatever production does.
  if (windowMs > timeoutMs) {
    throw new BadFlagError({
      flag: 'window',
      command: VERIFY_COMMAND,
      reason: `${windowMs} ms cannot close inside --timeout of ${timeoutMs} ms`,
      fix: EXAMPLE,
    });
  }
  return { origin, windowMs, intervalMs, timeoutMs, idleOk: flagList(ctx.args, 'idle-ok') };
}
