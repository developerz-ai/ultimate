// Single responsibility: writing a master-key file that only its owner can read, on every platform,
// and renaming one over another without losing to a reader that holds it open. POSIX gets the first
// from the create mode. Windows ignores the mode — the file inherits the profile directory's ACL —
// so there the temp file's ACL is cut to the current account BEFORE the rename makes it live.

// why: `node:fs` sync — Bun.write takes no mode and has no atomic rename; both run once, at a CLI
// command or at boot, before anything is served, so there is nothing for an async call to overlap.
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { backoffDelay } from './backoff';
import { renderCauseValue, stringField } from './error-render';
import { UltimateError } from './errors';

/** How long `icacls` or `whoami` may take before the write is refused as a failed ACL. */
const ACL_TIMEOUT_MS = 10_000;

/** Owner read/write — the mode every key file is CREATED with. */
export const OWNER_ONLY_MODE = 0o600;

/**
 * Tries for a rename over a file another process holds open. Windows refuses that rename with
 * EPERM or EBUSY rather than replacing the name the way POSIX does — an editor, an indexer or an
 * antivirus scan holding `.secrets.key` for a moment — so a short, bounded retry outlasts the
 * holder; a holder that never lets go is still an error, after ~150 ms rather than never.
 */
export const RENAME_ATTEMPTS = 5;
const isHeldOpen = (code: string | undefined): boolean => code === 'EPERM' || code === 'EBUSY';

/** Every effect, injectable: the Windows branch is proven on Linux with a fake. */
export interface KeyFileIo {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writeExclusive: (path: string, text: string, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  readonly runAcl: (argv: readonly string[]) => { exitCode: number; output: string };
  readonly username: () => string;
  readonly sleep: (ms: number) => void;
}

/** Built per call, never at import: the barrel reaches this module from browser bundles too. */
const systemIo = (): KeyFileIo => ({
  platform: process.platform,
  env: process.env,
  // `wx`: the mode applies only when a write CREATES the file, so never write into a leftover.
  writeExclusive: (path, text, mode) =>
    writeFileSync(path, text, { encoding: 'utf-8', mode, flag: 'wx' }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  runAcl: (argv) => {
    // Bounded: icacls on one local file answers in milliseconds; a hang must not hold the boot.
    const ran = Bun.spawnSync([...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: ACL_TIMEOUT_MS,
    });
    return {
      exitCode: ran.exitCode,
      output: `${ran.stdout.toString()}${ran.stderr.toString()}`.trim(),
    };
  },
  // `whoami` prints `DOMAIN\user`, the form icacls resolves. Never `node:os`'s `userInfo`: the
  // browser polyfill lacks it, and the barrel reaches this module from every island's bundle.
  username: () =>
    Bun.spawnSync(['whoami'], { stdout: 'pipe', timeout: ACL_TIMEOUT_MS }).stdout.toString().trim(),
  sleep: (ms) => Bun.sleepSync(ms),
});

/** The account the key is granted to: `DOMAIN\user` where Windows names both. */
export function aclPrincipal(
  env: Readonly<Record<string, string | undefined>>,
  username: () => string,
): string {
  const user = env['USERNAME'];
  const domain = env['USERDOMAIN'];
  if (user !== undefined && user !== '') {
    return domain !== undefined && domain !== '' ? `${domain}\\${user}` : user;
  }
  return username();
}

/**
 * `/inheritance:r` drops every ACE the directory handed down; `/grant:r` REPLACES any explicit one
 * for the principal with full control. What is left is one entry: the account that wrote the key.
 */
export function ownerOnlyAclArgv(path: string, principal: string): readonly string[] {
  return ['icacls', path, '/inheritance:r', '/grant:r', `${principal}:F`];
}

/** icacls refused, so the key was never written: no file is better than a readable one. */
export class SecretsKeyAclError extends UltimateError {
  constructor(input: { path: string; principal: string; exitCode: number; output: string }) {
    super({
      code: 'X_SECRETS_KEY_ACL_FAILED',
      cause: `icacls could not restrict ${renderCauseValue(input.path)} to ${renderCauseValue(input.principal)} (exit ${input.exitCode}: ${renderCauseValue(input.output)}), so the key was not written — on Windows a file's mode does not keep other accounts out, its ACL does`,
      fix: 'x doctor --json   # on Windows: where.exe icacls must resolve (C:\\Windows\\System32) and whoami names the account the key is granted to — or keep no key file and set ULTIMATE_SECRETS_KEY instead',
      meta: { path: input.path, exitCode: input.exitCode },
    });
  }
}

/** On win32, cut `path`'s ACL to the current account. A no-op elsewhere: the mode did it. */
export function restrictToOwner(path: string, io: KeyFileIo = systemIo()): void {
  if (io.platform !== 'win32') return;
  const principal = aclPrincipal(io.env, io.username);
  const ran = io.runAcl(ownerOnlyAclArgv(path, principal));
  if (ran.exitCode !== 0) {
    throw new SecretsKeyAclError({ path, principal, exitCode: ran.exitCode, output: ran.output });
  }
}

/** `rename(from, to)`, retried on EPERM/EBUSY only, `RENAME_ATTEMPTS` tries in all. */
export function renameOver(from: string, to: string, io: KeyFileIo = systemIo()): void {
  for (let attempt = 1; ; attempt++) {
    try {
      io.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isHeldOpen(stringField(error, 'code'))) throw error;
      io.sleep(backoffDelay({ attempt, base: 10, max: 160 }));
    }
  }
}

/**
 * Write `text` to `path`, readable by its owner alone, atomically: a fresh temp file created at
 * 0600 (and ACL-restricted on Windows) is renamed over the target, so a reader sees the old file or
 * the new one, and rotating over a key that was world-readable never leaves the new key so.
 */
export function writeOwnerOnlyFile(path: string, text: string, io: KeyFileIo = systemIo()): void {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    io.writeExclusive(temp, text, OWNER_ONLY_MODE);
    restrictToOwner(temp, io);
    renameOver(temp, path, io);
  } catch (error) {
    io.remove(temp);
    throw error;
  }
}
