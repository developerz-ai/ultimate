// The three refusals `x dev`'s lock claim raises that are NOT another `x dev`: an unreadable lock,
// a state directory that refuses the claim, and a port a stranger holds. Split from `dev-lock.ts`,
// which keeps the claim itself and `X_DEV_ALREADY_RUNNING`.

import { stringField, UltimateError } from '@ultimat3/core';
import { ownerText, type PortOwner } from './dev-lock-holder-dir';
import { quoteArg } from './shell-quote';

/**
 * The lock file exists, this process could not read it and could not remove it — which is not
 * "another x dev is running", and was reported as exactly that.
 *
 * `DevAlreadyRunningError` needs a `DevLock`, and the only one in hand on that path was `mine`:
 * the refusal then read `pid <this process> is already running x dev` with `fix: … kill <this
 * process>`, a remedy that kills the reader and a cause naming the wrong holder. Axiom 4 wants a
 * runnable fix and an honest cause, so the honest answer is its own code — the file is the
 * problem, and removing it is what a reader can actually do.
 */
export class DevLockUnreadableError extends UltimateError {
  constructor(input: { readonly path: string; readonly stateDir: string }) {
    super({
      code: 'X_DEV_LOCK_UNREADABLE',
      cause: `${input.path} could not be parsed as a dev lock and could not be removed, so x dev cannot tell whether another process owns ${input.stateDir}`,
      fix: `rm ${quoteArg(input.path)}   # then re-run x dev`,
      meta: { path: input.path, stateDir: input.stateDir },
    });
  }
}

/**
 * The state directory refused the claim itself: it could not be created, the lock could not be
 * staged in it, or the filesystem would not hard-link the staged file into place. None of that is
 * another `x dev` — only `EEXIST` is — and escaping raw it reached the operator as
 * `X_CLI_UNEXPECTED` with `fix: x doctor --json`, which says nothing about `.x/`.
 */
export class DevStateUnwritableError extends UltimateError {
  constructor(input: { readonly stateDir: string; readonly error: unknown }) {
    // Read the field, never cast and dereference: `unknown` is what a catch hands over.
    const errno = stringField(input.error, 'code') ?? 'an unreported errno';
    super({
      code: 'X_DEV_STATE_UNWRITABLE',
      cause: `${input.stateDir} could not be created, written, or hard-linked into (${errno}), so x dev cannot take its lock — a read-only checkout, a .x/ this user may not write, or a filesystem without hard links`,
      fix: `ls -ld ${quoteArg(input.stateDir)}   # make it writable by this user, on a filesystem that supports hard links, then re-run x dev`,
      meta: { stateDir: input.stateDir, errno },
      sourceError: input.error,
    });
  }
}

/**
 * The port is bound by something that is not us. Named separately from the lock case because the
 * remedy is different: a stranger's port is worked around with `--port`, while a second `x dev` on
 * this checkout is not a port problem at all and moving it would still fail on the database.
 *
 * The holder is NAMED when the OS will say. On a developer machine :3000 is usually another
 * project's dev server, and "pid 41234, bun" is the difference between knowing that and guessing —
 * which decides whether the right move is `--port` or stopping the other thing. Both are offered,
 * `--port` first: moving your own server is always safe, and killing someone else's is not.
 */
export class DevPortInUseError extends UltimateError {
  constructor(input: {
    readonly port: number;
    readonly suggestion: number;
    readonly holder?: PortOwner;
  }) {
    const holder = input.holder ?? {};
    const named = ownerText(holder) ?? 'another process';
    super({
      code: 'X_PORT_IN_USE',
      cause: `:${input.port} is already bound by ${named}, so the web role cannot listen — on a machine running several projects this is usually another one's dev server, not a stale copy of this one`,
      fix:
        holder.pid === undefined
          ? `x dev --port ${quoteArg(String(input.suggestion))}`
          : `x dev --port ${quoteArg(String(input.suggestion))}   # or free it, if that pid is yours: kill ${holder.pid}`,
      meta: { port: input.port, ...holder },
    });
  }
}
