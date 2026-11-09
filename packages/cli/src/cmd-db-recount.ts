// `x db recount <entity>.<column>`: the counters `countedIn` declares, compared with the truth and
// — with `--write` — set to it. A counter drifts only when its trigger was missing or disabled
// (`X_LIFECYCLE_TRIGGER_MISSING`); this is the repair, and the dry run is the report.

import {
  CROSS_TENANT_SETTING,
  raw,
  recountDriftSql,
  recountSql,
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

interface DriftRow {
  readonly key: string;
  readonly stored: number;
  readonly actual: number;
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
    // One transaction, cross-tenant: a counter is every tenant's, and under forced row security an
    // unset tenant would match no row.
    const drift = await withTransaction(
      async (tx) => {
        await setLocal(tx, { [CROSS_TENANT_SETTING]: 'on' });
        const rows = await tx.query<DriftRow>(raw(recountDriftSql(parent.$table, counter)));
        if (write && rows.length > 0) await tx.execute(raw(recountSql(parent.$table, counter)));
        return rows;
      },
      { client: started.client },
    );
    return {
      ok: findings.length === 0 && (write || drift.length === 0),
      command: 'db',
      summary: msg(write ? 'cli.db.recount.repaired' : 'cli.db.recount.drift', {
        target,
        count: drift.length,
      }),
      findings: [
        ...findings,
        ...(write || drift.length === 0
          ? []
          : [
              {
                code: 'X_LIFECYCLE_TRIGGER_MISSING',
                cause: `${drift.length} row(s) of ${parent.$table} hold a ${counter.column} that is not the count of ${counter.table} rows pointing at them`,
                fix: `x db recount ${quoteArg(target)} --write --json`,
              },
            ]),
      ],
      lines: drift
        .slice(0, SHOWN)
        .map((row) => `  ${row.key}  stored ${row.stored}  actual ${row.actual}`),
      data: {
        target,
        write,
        drifted: drift.length,
        rows: drift.slice(0, SHOWN).map((row) => ({ ...row })),
      },
    };
  } finally {
    await started.client.close();
    await started.replica?.close();
  }
}
