// `x vapid` — the Web Push key pair (`pwa.push`). `create` mints a P-256 pair on WebCrypto and
// seals BOTH halves into `secrets.enc.json` in one write, so the two environment variables the
// boot reads can never come from different pairs; `show` names which pair this app signs with.
// The private key is never printed, in either renderer — `x secrets`' rule.

import type { MasterKeyRef, SecretValues } from '@ultimat3/core';
import {
  isUltimateError,
  readSecretsFile,
  requireMasterKey,
  SECRETS_FILE,
  writeSecretsFile,
} from '@ultimat3/core';
import {
  DEV_VAPID_KEYS,
  generateVapidKeys,
  VAPID_PRIVATE_KEY_ENV,
  VAPID_PUBLIC_KEY_ENV,
} from '@ultimat3/pwa';
import { requireAppRoot } from './app-root';
import { SecretsExistsError } from './cmd-secrets';
import { vapidSpec } from './cmd-vapid-spec';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult } from './output';
import { recoverRotation } from './secrets-rotation';

/** The app's master key, as `x secrets` opens it — after finishing a rotation a crash interrupted. */
const secretsKeyFor = (root: string, env: CommandContext['env']): Promise<MasterKeyRef> =>
  recoverRotation(root, requireMasterKey(root, env));

/**
 * Both halves into the sealed file, or neither. A pair already there is refused: rotating a VAPID
 * key unsubscribes every browser that subscribed with the old one, so it is a decision taken in
 * `x secrets edit` (delete both lines, then create), never a side effect of re-running a command.
 */
async function create(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot('vapid create', ctx.cwd).dir;
  const key = await secretsKeyFor(root, ctx.env);
  const before: SecretValues = await readSecretsFile(root, key);
  if (before[VAPID_PUBLIC_KEY_ENV] !== undefined || before[VAPID_PRIVATE_KEY_ENV] !== undefined) {
    throw new SecretsExistsError({
      path: `${SECRETS_FILE} (${VAPID_PUBLIC_KEY_ENV}, ${VAPID_PRIVATE_KEY_ENV})`,
      fix: `x secrets edit   # delete both ${VAPID_PUBLIC_KEY_ENV} and ${VAPID_PRIVATE_KEY_ENV} first — every subscriber subscribes again after a new pair`,
    });
  }
  const pair = await generateVapidKeys();
  await writeSecretsFile(
    root,
    {
      ...before,
      [VAPID_PUBLIC_KEY_ENV]: pair.publicKey,
      [VAPID_PRIVATE_KEY_ENV]: pair.privateKey,
    },
    key,
  );
  return {
    ok: true,
    command: 'vapid',
    summary: msg('cli.vapid.created', { path: SECRETS_FILE }),
    lines: [msg('cli.vapid.public', { key: pair.publicKey })],
    data: {
      path: SECRETS_FILE,
      publicKey: pair.publicKey,
      sealed: [VAPID_PUBLIC_KEY_ENV, VAPID_PRIVATE_KEY_ENV],
    },
  };
}

type Source = 'environment' | 'sealed' | 'development';

/** One literal key per source, so the catalog's every key is a string a reader can grep for. */
const SOURCE_SUMMARY = {
  environment: 'cli.vapid.source.environment',
  sealed: 'cli.vapid.source.sealed',
  development: 'cli.vapid.source.development',
} as const satisfies Record<Source, string>;

/**
 * The pair the boot would resolve, in its order: the environment (a deploy's, or `installSecrets()`
 * having copied the sealed file into it), then the sealed file read directly, then the published
 * development pair a local process falls back to.
 */
async function show(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot('vapid show', ctx.cwd).dir;
  const fromEnv = ctx.env[VAPID_PUBLIC_KEY_ENV]?.trim();
  let source: Source = 'development';
  let publicKey = DEV_VAPID_KEYS.publicKey;
  let privateSet = false;
  if (fromEnv !== undefined && fromEnv !== '') {
    source = 'environment';
    publicKey = fromEnv;
    privateSet = (ctx.env[VAPID_PRIVATE_KEY_ENV] ?? '').trim() !== '';
  } else {
    const sealed = await readSealed(root, ctx);
    const sealedKey = sealed?.[VAPID_PUBLIC_KEY_ENV];
    if (sealed !== undefined && sealedKey !== undefined) {
      source = 'sealed';
      publicKey = sealedKey;
      privateSet = sealed[VAPID_PRIVATE_KEY_ENV] !== undefined;
    }
  }
  return {
    ok: true,
    command: 'vapid',
    summary: msg(SOURCE_SUMMARY[source], { path: SECRETS_FILE }),
    lines: [msg('cli.vapid.public', { key: publicKey })],
    data: { source, publicKey, privateKey: privateSet || source === 'development' },
  };
}

/** Absent, not broken: no secrets file, or no key to open one — the development pair is in force. */
const ABSENT: ReadonlySet<string> = new Set(['X_SECRETS_FILE_MISSING', 'X_SECRETS_KEY_MISSING']);

/**
 * The sealed values, or `undefined` when this checkout has no secrets file or no key to open it.
 * Every other refusal — a tampered file, a key for another file, a file that is not one, a rotation
 * that cannot be finished — is thrown with its own fix: a sealed pair is THERE but unreadable, and
 * reporting `development` would send the reader to `x vapid create`, which refuses the pair.
 */
async function readSealed(root: string, ctx: CommandContext): Promise<SecretValues | undefined> {
  try {
    return await readSecretsFile(root, await secretsKeyFor(root, ctx.env));
  } catch (error) {
    if (isUltimateError(error) && ABSENT.has(error.code)) return undefined;
    throw error;
  }
}

export const vapidCommand: CliCommand = {
  spec: vapidSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    return (ctx.args.subcommand ?? 'show') === 'create' ? create(ctx) : show(ctx);
  },
};
