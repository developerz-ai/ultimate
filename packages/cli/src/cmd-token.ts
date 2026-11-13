// `x token create|list|revoke` — the app's machine credentials, in its own `x_api_keys`, through
// `@ultimat3/auth`'s `issueApiKey` / `describeApiKey` / `revokeApiKey`: the keys an MCP endpoint's
// `apiKeyResolver` accepts. The plaintext is shown once, by `create`, and never logged; `list`
// answers `describeApiKey`'s shape, which holds no hash and no secret.

import type { ApiKeyStore, ApiKeySummary } from '@ultimat3/auth';
import { describeApiKey, issueApiKey, postgresAuthAdapter, revokeApiKey } from '@ultimat3/auth';
import { type Clock, systemClock, tryResolveEnvironment } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { plannedSubcommand } from './cmd-planned';
import { TOKEN_MAX_DAYS, tokenSpec } from './cmd-token-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { parseIntFlag } from './flag-number';
import { readsAsProduction } from './mcp-db-target';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagList, flagString } from './parse';
import { openAppQueue } from './runtime-boot-ports';

export interface OpenTokenStore {
  readonly store: ApiKeyStore;
  close(): Promise<void>;
}

/** The app's own database, opened as `x auth` opens it, and ALWAYS released (the PGlite lock). */
async function openAppTokenStore(root: string, ctx: CommandContext): Promise<OpenTokenStore> {
  const queue = await openAppQueue(root, ctx.env);
  return { store: postgresAuthAdapter(queue.db), close: () => queue.stop() };
}

const DAY_MS = 86_400_000;

/** A summary as JSON: dates as ISO-8601 UTC strings, `null` kept. */
const summaryJson = (key: ApiKeySummary): JsonValue => ({
  id: key.id,
  prefix: key.prefix,
  scopes: [...key.scopes],
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  expiresAt: key.expiresAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
});

/** One human line per key: no secret is in a summary, so every field may be printed. */
const summaryLine = (key: ApiKeySummary): string =>
  msg('cli.token.row', {
    prefix: key.prefix,
    scopes: key.scopes.join(','),
    state:
      key.revokedAt !== null
        ? msg('cli.token.revoked', { at: key.revokedAt.toISOString() })
        : key.expiresAt === null
          ? msg('cli.token.noExpiry')
          : msg('cli.token.expires', { at: key.expiresAt.toISOString() }),
  });

/**
 * `--env` unsaid is the environment's own label, never a constant: a `dev` default stamped every
 * key minted against production `ult_dev_…`, which reads as harmless in a log or a leak report.
 * Unreadable `ULTIMATE_ENV` reads as production, as `x explain` and the MCP host read it.
 */
const envLabel = (env: CommandContext['env']): string => {
  if (readsAsProduction(env)) return 'prod';
  return tryResolveEnvironment({ env }) === 'staging' ? 'stage' : 'dev';
};

/** Every flag `create` reads, held before the database opens: a typo costs no boot. */
function createInput(ctx: CommandContext, clock: Clock) {
  const scopes = flagList(ctx.args, 'scopes');
  if (scopes.length === 0) {
    throw new BadFlagError({
      flag: 'scopes',
      command: 'token create',
      reason: 'a token carries exactly the permissions it names, and none were named',
      fix: 'x token create --scopes post:read --json',
    });
  }
  const rawDays = flagString(ctx.args, 'days');
  const days =
    rawDays === undefined
      ? undefined
      : parseIntFlag(rawDays, {
          name: 'days',
          command: 'token create',
          min: 1,
          max: TOKEN_MAX_DAYS,
          example: 'x token create --scopes post:read --days 30 --json',
        });
  return {
    env: flagString(ctx.args, 'env') ?? envLabel(ctx.env),
    scopes,
    userId: flagString(ctx.args, 'user') ?? null,
    orgId: flagString(ctx.args, 'org') ?? null,
    expiresAt: days === undefined ? null : new Date(clock.now().getTime() + days * DAY_MS),
    clock,
  };
}

async function create(ctx: CommandContext, open: OpenToken, root: string, clock: Clock) {
  // Issued before the store opens: `issueApiKey` refuses a wildcard scope or a bad env label, and
  // a refusal must not cost a database boot.
  const issued = issueApiKey(createInput(ctx, clock));
  const handle = await open(root, ctx);
  try {
    await handle.store.putApiKey(issued.record);
  } finally {
    await handle.close();
  }
  const key = describeApiKey(issued.record);
  // The plaintext once per render: the human one prints `lines`, `--json` prints `data`. Never in
  // the summary, which both print.
  return ok('token', msg('cli.token.created', { prefix: key.prefix, count: key.scopes.length }), {
    lines: [msg('cli.token.plaintext', { token: issued.plaintext }), msg('cli.token.once')],
    data: { token: issued.plaintext, key: summaryJson(key) },
  });
}

async function list(ctx: CommandContext, open: OpenToken, root: string) {
  const owner = flagString(ctx.args, 'owner');
  if (owner === undefined) {
    throw new BadFlagError({
      flag: 'owner',
      command: 'token list',
      reason:
        'tokens are listed by the user or org they belong to; a token issued with neither is listed by nobody and revoked by its id',
      fix: 'x token list --owner <user-or-org-id> --json',
    });
  }
  const handle = await open(root, ctx);
  const keys = await handle.store.listApiKeys(owner).finally(() => handle.close());
  const summaries = keys.map(describeApiKey);
  return ok('token', msg('cli.token.listed', { count: summaries.length, owner }), {
    lines: summaries.map(summaryLine),
    data: { owner, keys: summaries.map(summaryJson) },
  });
}

async function revoke(ctx: CommandContext, open: OpenToken, root: string, clock: Clock) {
  const id = ctx.args.positionals[0];
  if (id === undefined) {
    throw new MissingPositionalError({
      command: 'token revoke',
      positional: 'id',
      example: 'x token list --owner <user-or-org-id> --json   # then x token revoke <id>',
    });
  }
  const handle = await open(root, ctx);
  const revoked = await revokeApiKey(handle.store, id, clock).finally(() => handle.close());
  // Unknown and already-revoked answer alike, as `verifyApiKey` does: neither is a key that works,
  // so a second run of the same revoke is the same success — idempotent, like `x auth seal-mfa`.
  return ok('token', msg(revoked ? 'cli.token.revokedOne' : 'cli.token.notLive', { id }), {
    data: { id, revoked },
  });
}

export type OpenToken = (root: string, ctx: CommandContext) => Promise<OpenTokenStore>;

/** `open` and `clock` are the seams a test drives; the shipped command opens the app's database. */
export const tokenCommandOver = (open: OpenToken, clock: Clock = systemClock): CliCommand => ({
  spec: tokenSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('token', ctx.cwd).dir;
    const sub = ctx.args.subcommand;
    if (sub === 'create') return create(ctx, open, root, clock);
    if (sub === 'list') return list(ctx, open, root);
    if (sub === 'revoke') return revoke(ctx, open, root, clock);
    throw plannedSubcommand('token', sub ?? 'grant');
  },
});

export const tokenCommand: CliCommand = tokenCommandOver(openAppTokenStore);
