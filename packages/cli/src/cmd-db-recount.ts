// `x db recount <entity>.<column>`: the counters `countedIn` declares, compared with the truth and
// — with `--write` — set to it. A counter drifts only when its trigger was missing or disabled
// (`X_LIFECYCLE_TRIGGER_MISSING`); this is the repair, and the dry run is the report. The parent is
// walked in key-range windows, one transaction each, so a big table never holds one long lock.

import type { CounterDescriptionLike, DbClient } from '@ultimat3/db';
import {
  CROSS_TENANT_SETTING,
  recountBatchSql,
  recountDriftBatchSql,
  recountWindowSql,
  setLocal,
  withTransaction,
} from '@ultimat3/db';
import { countersOf, describeCounter, getEntity } from '@ultimat3/entity';
import { loadApp } from './app-load';
import { loadAppRuntime } from './app-runtime';
import type { CommandContext } from './command';
import { DevAlreadyRunningError, liveDevLock } from './dev-lock';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool } from './parse';
import { resolveServices } from './runtime-bindings';
import { installBootPorts } from './runtime-boot-ports';
import { startDb } from './runtime-queue';
import { quoteArg } from './shell-quote';

/** Rows of drift a report lists; the count is always whole. */
const SHOWN = 50;

/**
 * Parent rows per window. Each window is one transaction: its row locks are held only while its
 * own statements run, so writers to the rest of the table never wait on the whole sweep.
 */
export const RECOUNT_BATCH = 1_000;

interface DriftRow {
  readonly key: string;
  readonly stored: number;
  readonly actual: number;
}

export interface RecountReport {
  /** Windows walked, each its own transaction. */
  readonly batches: number;
  readonly drifted: number;
  /** The first `SHOWN` drifted rows, in key order. */
  readonly rows: readonly DriftRow[];
}

/**
 * The sweep: windows of `batch` parent keys in key order. Each transaction reads its window's
 * drift and, with `write`, repairs it; cross-tenant, because a counter is every tenant's and under
 * forced row security an unset tenant would match no row. A dry run writes nothing.
 *
 * Batched directly rather than through `@ultimat3/jobs`' `backfill()`: that factory DECLARES a job
 * at module scope for a worker to run, and this is one operator command over a counter named at
 * run time — no queue, no worker, no ledger row to leave behind.
 */
export async function recountInBatches(
  client: DbClient,
  parent: string,
  counter: CounterDescriptionLike,
  options: { readonly write: boolean; readonly batch?: number },
): Promise<RecountReport> {
  const size = options.batch ?? RECOUNT_BATCH;
  const rows: DriftRow[] = [];
  let drifted = 0;
  let batches = 0;
  let after: string | null = null;
  for (;;) {
    const from: string | null = after;
    const last: string | null = await withTransaction(
      async (tx): Promise<string | null> => {
        await setLocal(tx, { [CROSS_TENANT_SETTING]: 'on' });
        const [window] = await tx.query<{ last: string | null }>(
          recountWindowSql(parent, counter, from, size),
        );
        const end: string | null = window?.last ?? null;
        if (end === null) return null;
        const found = await tx.query<DriftRow>(recountDriftBatchSql(parent, counter, from, end));
        if (options.write && found.length > 0) {
          await tx.execute(recountBatchSql(parent, counter, from, end));
        }
        drifted += found.length;
        rows.push(...found.slice(0, SHOWN - rows.length));
        return end;
      },
      { client },
    );
    if (last === null) return { batches, drifted, rows };
    batches += 1;
    after = last;
  }
}

const refuse = (target: string, reason: string): never => {
  throw new BadFlagError({
    flag: 'name',
    command: 'db recount',
    reason: `"${target}" ${reason}`,
    fix: 'x entities list --json   # then x db recount <entity>.<column> naming a countedIn column',
  });
};

/** `<entity>.<column>` to the one counter it names, after the app's modules declared them. */
function counterNamed(target: string) {
  const [name, column, ...rest] = target.split('.');
  if (name === undefined || column === undefined || rest.length > 0) {
    return refuse(target, 'is not <entity>.<column>');
  }
  const parent = getEntity(name)?.core;
  if (parent === undefined) return refuse(target, `names no entity "${name}"`);
  const counter = countersOf(parent).find((each) => each.column === column);
  if (counter === undefined)
    return refuse(target, `names no column any countedIn keeps on ${name}`);
  return { parent, counter: describeCounter(counter) };
}

/**
 * `runtime.ts`'s boot ports first: `loadApp` evaluates the app's modules, and one that seals or
 * reads a secret at module scope must see the app's own source and clock (`runtime-boot-ports.ts`).
 */
export async function runRecountCommand(ctx: CommandContext, root: string): Promise<CommandResult> {
  const booted = await installBootPorts(await loadAppRuntime(root));
  try {
    return await recount(ctx, root);
  } finally {
    for (const release of booted.reverse()) await release();
  }
}

async function recount(ctx: CommandContext, root: string): Promise<CommandResult> {
  const target = ctx.args.positionals[0];
  if (target === undefined) return refuse('', 'is missing: name the counter as <entity>.<column>');
  const { findings } = await loadApp(root);
  const { parent, counter } = counterNamed(target);
  const write = flagBool(ctx.args, 'write');
  const services = resolveServices(root, ctx.env);
  if (services.db.mode === 'embedded') {
    const holder = liveDevLock(services.stateDir);
    if (holder !== undefined) {
      throw new DevAlreadyRunningError({
        lock: holder,
        stateDir: services.stateDir,
        embeddedDb: true,
      });
    }
  }
  const started = startDb(services, ctx.env);
  try {
    const report = await recountInBatches(started.client, parent.$table, counter, { write });
    const drift = report.rows;
    return {
      ok: findings.length === 0 && (write || report.drifted === 0),
      command: 'db',
      summary: msg(write ? 'cli.db.recount.repaired' : 'cli.db.recount.drift', {
        target,
        count: report.drifted,
      }),
      findings: [
        ...findings,
        ...(write || report.drifted === 0
          ? []
          : [
              {
                code: 'X_LIFECYCLE_TRIGGER_MISSING',
                cause: `${report.drifted} row(s) of ${parent.$table} hold a ${counter.column} that is not the count of ${counter.table} rows pointing at them`,
                fix: `x db recount ${quoteArg(target)} --write --json`,
              },
            ]),
      ],
      lines: drift.map((row) => `  ${row.key}  stored ${row.stored}  actual ${row.actual}`),
      data: {
        target,
        write,
        drifted: report.drifted,
        batches: report.batches,
        rows: drift.map((row) => ({ ...row })),
      },
    };
  } finally {
    await started.client.close();
    await started.replica?.close();
  }
}
