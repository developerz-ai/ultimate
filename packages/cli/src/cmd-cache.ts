// `x cache graph|bust <tag>|clear` — the tag graph off the manifest (`cache-graph.ts`), and a bust
// run the way an action's `invalidates` runs one: the app's own tiers registered by the same boot a
// role makes (`startServices`), then `invalidateTags`, which drops the shared tiers, purges the
// edge and publishes on the bus every replica listens to. No second eviction path.

import type { InvalidationReport } from '@ultimat3/cache';
import {
  assertKnownTags,
  CacheDriverUnavailableError,
  invalidateTags,
  knownTags,
  parseTag,
} from '@ultimat3/cache';
import { renderFixShellArg } from '@ultimat3/core';
import { redisUrlSource } from '@ultimat3/core/redis';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import { loadAppRuntime } from './app-runtime';
import { cacheGraph, neverEvicted } from './cache-graph';
import { cacheSpec } from './cmd-cache-spec';
import { plannedSubcommand } from './cmd-planned';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { findingFrom } from './output';
import { flagString } from './parse';
import { resolveServices } from './runtime-bindings';
import { startServices } from './runtime-services';

/** The app's tiers and bus, booted for one bust. */
export interface CacheHandle {
  invalidate(tags: readonly string[]): Promise<InvalidationReport>;
  /** False when the bus is in-process: no other process hears this one. */
  readonly reachesPeers: boolean;
  /** The bus as the boot line names it — never a URL. */
  readonly bus: string;
  close(): Promise<void>;
}

export type OpenCache = (root: string, ctx: CommandContext) => Promise<CacheHandle>;

/** A role's boot with no role started: the tiers `cache.tiers` declares and the broadcast. */
const openAppCache: OpenCache = async (root, ctx) => {
  const running = await startServices(
    resolveServices(root, ctx.env),
    ctx.env,
    await loadAppRuntime(root),
    'apply',
    [],
  );
  return {
    invalidate: (tags) => invalidateTags(tags.map(parseTag)),
    reachesPeers: !(
      running.transport instanceof InProcessTransport && redisUrlSource(ctx.env) === undefined
    ),
    bus: running.transport.name,
    close: () => running.stop(),
  };
};

async function graph(root: string, only: string | undefined): Promise<CommandResult> {
  const { manifest, findings } = await appManifest(root);
  const tag = only === undefined ? undefined : parseTag(only);
  // After the app loaded, so the declared set is the app's: an undeclared tag is X_CACHE_TAG_UNKNOWN
  // naming the declared ones, never an empty graph that reads as "nothing depends on it".
  if (tag !== undefined) assertKnownTags([tag]);
  const rows = cacheGraph(manifest).filter((row) => tag === undefined || row.tag === tag.entity);
  const stale = rows.filter(neverEvicted).map((row) => row.tag);
  return {
    ok: findings.length === 0,
    command: 'cache',
    summary: msg('cli.cache.graph', { tags: rows.length, stale: stale.length }),
    findings,
    lines: rows.map((row) =>
      msg('cli.cache.graphRow', {
        tag: row.tag,
        writers: row.writers.join(', ') || '—',
        readers: [...row.readers, ...row.routes].join(', ') || '—',
      }),
    ),
    data: {
      tags: rows.map((row) => ({
        tag: row.tag,
        writers: [...row.writers],
        readers: [...row.readers],
        routes: [...row.routes],
      })),
      neverEvicted: stale,
    },
  };
}

/** A tier that failed the bust, as the finding an operator acts on. */
const tierFinding = (error: { tier: string; message: string }, retry: string): Finding =>
  findingFrom(
    new CacheDriverUnavailableError({
      driver: error.tier,
      cause: error.message,
      fix: `${retry}   # again once it answers; x doctor --json names the tier's binding`,
    }),
  );

async function bust(
  ctx: CommandContext,
  open: OpenCache,
  root: string,
  /** Read AFTER the app loads: `clear`'s tags are the ones its modules declare. */
  tagsOf: () => readonly string[],
  retry: string,
): Promise<CommandResult> {
  // Loaded first: the declared tags are registered by the app's modules, and an undeclared one is
  // refused by `invalidateTags` itself (X_CACHE_TAG_UNKNOWN) rather than busting nothing.
  const { findings } = await loadApp(root);
  const tags = tagsOf();
  const handle = await open(root, ctx);
  const report = await handle.invalidate(tags).finally(() => handle.close());
  const failures = report.errors.map((error) => tierFinding(error, retry));
  const data: JsonValue = {
    tags: [...report.tags],
    tiers: report.tiers.map((tier) => ({
      tier: tier.tier,
      keys: tier.keys.length,
      ...(tier.skipped === undefined ? {} : { skipped: tier.skipped }),
    })),
    isr: [...report.isr],
    cdn: [...report.cdn],
    bus: handle.bus,
    reachesPeers: handle.reachesPeers,
    durationMs: report.durationMs,
  };
  return {
    ok: findings.length === 0 && failures.length === 0,
    command: 'cache',
    summary: handle.reachesPeers
      ? msg('cli.cache.busted', { tags: report.tags.length, bus: handle.bus })
      : msg('cli.cache.bustedLocal', { tags: report.tags.length }),
    findings: [...findings, ...failures],
    lines: report.tiers.map((tier) =>
      msg('cli.cache.tierRow', { tier: tier.tier, keys: tier.keys.length }),
    ),
    data,
  };
}

/** `open` is the seam a test hands tiers through; the shipped command boots the app's own. */
export const cacheCommandOver = (open: OpenCache): CliCommand => ({
  spec: cacheSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('cache', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'graph';
    if (sub === 'graph') return graph(root, flagString(ctx.args, 'tag'));
    if (sub === 'bust') {
      const tag = ctx.args.positionals[0];
      if (tag === undefined) {
        throw new MissingPositionalError({
          command: 'cache bust',
          positional: 'tag',
          example: 'x cache graph --json   # the declared tags; then x cache bust <tag>',
        });
      }
      return bust(
        ctx,
        open,
        root,
        () => [tag],
        `x cache bust ${renderFixShellArg(tag, '<tag>')} --json`,
      );
    }
    if (sub === 'clear') {
      // Every declared tag through the same bust, so each peer drops what each one covers. An
      // entry cached under no tag is not reached: it waits for its TTL, as it would for any write.
      return bust(ctx, open, root, knownTags, 'x cache clear --json');
    }
    throw plannedSubcommand('cache', sub);
  },
});

export const cacheCommand: CliCommand = cacheCommandOver(openAppCache);
