// `x auth seal-mfa` — seal every `x_users.mfa_secret` still stored in the clear, in place, under
// the app's master key. The one-shot an upgrade onto sealed second-factor secrets owes: readers
// refuse a plaintext value (`X_MFA_SECRET_UNSEALED`), and this is the command that refusal names.
// Idempotent — a sealed value is counted and left alone — so an interrupted run is finished by
// running it again.

import type { MfaSecretStore } from '@ultimat3/auth';
import { postgresAuthAdapter, sealMfaSecrets } from '@ultimat3/auth';
import { requireAppRoot } from './app-root';
import { authSpec } from './cmd-auth-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { msg } from './messages';
import type { CommandResult } from './output';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';

export interface OpenAuthStore extends MfaSecretStore {
  close(): Promise<void>;
}

/**
 * The app's own database, opened the way every other command opens it (`startQueue`: the
 * framework's tables are applied first, so `x_users` exists) and ALWAYS released — a CLI that
 * exits holding the PGlite lock breaks the next command run against this app.
 */
async function openAppAuthStore(root: string, ctx: CommandContext): Promise<OpenAuthStore> {
  const queue = await startQueue(resolveServices(root, ctx.env), undefined, ctx.env);
  return { adapter: postgresAuthAdapter(queue.db), close: () => queue.stop() };
}

/** `open` is the seam a test supplies a store through; the shipped command opens the app's. */
export const authCommandOver = (
  open: (root: string, ctx: CommandContext) => Promise<OpenAuthStore>,
): CliCommand => ({
  spec: authSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('auth', ctx.cwd).dir;
    const store = await open(root, ctx);
    try {
      // The key is read from the command's own environment and the app's `.secrets.key`: with
      // neither, the first seal refuses (`X_SEAL_KEY_MISSING`) before any row is written.
      const report = await sealMfaSecrets(store, { root, env: ctx.env });
      return ok(
        'auth',
        msg('cli.auth.sealed', {
          sealed: report.sealed,
          already: report.alreadySealed,
          skipped: report.skipped,
        }),
        {
          data: {
            sealed: report.sealed,
            alreadySealed: report.alreadySealed,
            skipped: report.skipped,
          },
        },
      );
    } finally {
      await store.close();
    }
  },
});

export const authCommand: CliCommand = authCommandOver(openAppAuthStore);
