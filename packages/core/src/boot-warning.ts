// Single responsibility: `bootWarning` — the ONE boot line an app or the framework says where a
// booting role can act on it, once per process or once per build. Production said every warning
// in all five roles on every boot; a line a role cannot act on is noise that buries the one it can.
// The per-build memory is a slot the boot fills (cli's storage marker): core cannot reach a disk.

import { adapterSlot } from './adapter-slot';
import { assertCoded } from './assert';
import { renderCauseValue } from './error-render';
import { logger } from './logger';
import type { Role } from './roles';
import { isRole, resolveRole } from './roles';

/** Absent: every call says it. `process`: once per process. `build`: once per build id per role. */
export type BootWarningOnce = 'process' | 'build';

export interface BootWarningSpec {
  /** `X_SCREAMING_SNAKE`: the field an operator's alert matches on. */
  readonly code: string;
  /** The roles that can act on the line. Every other role booting says nothing. */
  readonly roles: readonly Role[];
  readonly once?: BootWarningOnce | undefined;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The per-build memory: calls `say` unless a process of this build and `claim.role` already said
 * `claim.code`. Fails open — a store that cannot answer says the line rather than losing it.
 */
export type BuildOnceStore = (
  claim: { readonly code: string; readonly role: Role },
  say: () => void,
) => Promise<void>;

export interface BootWarningLog {
  warn(message: string, fields: Readonly<Record<string, unknown>>): void;
}

/** Who is booting, where `build` remembers, where lines go. Each falls back field by field. */
export interface BootWarningContext {
  /** `x dev` runs several roles in one process. Default: `[resolveRole()]`. */
  readonly roles?: readonly Role[] | undefined;
  /** Unset: `once: 'build'` degrades to once per process. */
  readonly buildOnce?: BuildOnceStore | undefined;
  readonly log?: BootWarningLog | undefined;
}

const ONCE: ReadonlySet<unknown> = new Set(['process', 'build']);
const SCREAMING_SNAKE = /^X(?:_[A-Z0-9]+)+$/;

/** A stack of frames, each removed by its own release: boots may stop in any order. */
const installed = adapterSlot<BootWarningContext>(() => ({}));
/** Codes said under `once: 'process'` (or `build` with no store) by this process. */
const SAID = new Set<string>();

/** The boot's half: the booting roles and the build store. Returns the release of THIS frame. */
export function installBootWarnings(context: BootWarningContext): () => void {
  return installed.install(context);
}

/** Whether any booting role is one the warning names. */
export const bootRolesConcerned = (declared: readonly Role[], booting: readonly Role[]): boolean =>
  booting.some((role) => declared.includes(role));

function check(spec: BootWarningSpec): void {
  const fix = `bootWarning({ code: 'X_<NAME>', roles: ['web'], once: 'process', message: '…' })   # edit the call that declares ${renderCauseValue(spec.code)}`;
  assertCoded(
    typeof spec.code === 'string' && SCREAMING_SNAKE.test(spec.code),
    'X_INVARIANT',
    `bootWarning code ${renderCauseValue(spec.code)} is not X_SCREAMING_SNAKE`,
    fix,
  );
  assertCoded(
    Array.isArray(spec.roles) && spec.roles.length > 0 && spec.roles.every(isRole),
    'X_INVARIANT',
    `bootWarning ${spec.code} names roles ${renderCauseValue(spec.roles)}: a non-empty list of web, sync, worker, scheduler, migrate, replicator`,
    fix,
  );
  assertCoded(
    typeof spec.message === 'string' && spec.message.length > 0,
    'X_INVARIANT',
    `bootWarning ${spec.code} has no message`,
    fix,
  );
  assertCoded(
    spec.once === undefined || ONCE.has(spec.once),
    'X_INVARIANT',
    `bootWarning ${spec.code} gives once ${renderCauseValue(spec.once)}: 'process', 'build' or omitted`,
    fix,
  );
}

/**
 * Say `spec.message` as a `warn` line carrying `{ code, ...fields }` when a booting role is one of
 * `spec.roles`, at most as often as `once` allows. Answers whether it was said.
 *
 * ```ts
 * await bootWarning({
 *   code: 'X_APP_SEARCH_INDEX_LOCAL',
 *   roles: ['web'],
 *   once: 'build',
 *   message: 'search reads an in-process index: each web pod answers from its own copy',
 *   fields: { driver: 'memory' },
 * });
 * ```
 */
export async function bootWarning(
  spec: BootWarningSpec,
  context?: BootWarningContext,
): Promise<boolean> {
  check(spec);
  const frame = installed.current();
  const booting = context?.roles ?? frame.roles ?? [resolveRole()];
  const role = booting.find((candidate) => spec.roles.includes(candidate));
  if (role === undefined) return false;
  const log = context?.log ?? frame.log ?? logger;
  const fields: Record<string, unknown> = { code: spec.code };
  for (const [key, value] of Object.entries(spec.fields ?? {})) {
    if (key !== 'code') fields[key] = value;
  }
  let said = false;
  const say = (): void => {
    said = true;
    log.warn(spec.message, fields);
  };
  const store = context?.buildOnce ?? frame.buildOnce;
  if (spec.once === 'build' && store !== undefined) {
    await store({ code: spec.code, role }, say);
    return said;
  }
  if (spec.once !== undefined) {
    if (SAID.has(spec.code)) return false;
    SAID.add(spec.code);
  }
  say();
  return said;
}

/** Test seam: forget what this process said. Production never forgets. */
export const resetBootWarnings = (): void => {
  SAID.clear();
};
