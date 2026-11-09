// `x db diagnostics`: opens the app's database the way every role does, asks `@ultimat3/db`'s
// `dbDiagnostics()` and renders one table per answered section. Facts, never a verdict: exit 0
// whatever they say, and the one failure is a connection that never opens (`X_DB_UNAVAILABLE`).

import {
  type DbDiagnostics,
  type DiagnosticSection,
  dbDiagnostics,
} from '@ultimat3/db/diagnostics';
import type { CommandContext } from './command';
import { DevAlreadyRunningError, liveDevLock } from './dev-lock';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { resolveServices } from './runtime-bindings';
import { startDb } from './runtime-queue';
import { renderTable } from './table';

type Cell = string | number | boolean | null;

/** A row is a flat record of scalars by construction (`db-diagnostics-rows.ts`); read it as one. */
const cells = (row: object): Readonly<Record<string, Cell>> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : null,
    ]),
  );

/** `--json`'s `data`: the report as `dbDiagnostics` built it, re-typed for the JSON renderer. */
export function diagnosticsJson(report: DbDiagnostics): JsonValue {
  return Object.fromEntries(
    Object.entries(report).map(([name, section]: [string, DiagnosticSection<object>]) => [
      name,
      section.available
        ? { available: true, rows: section.rows.map((row) => ({ ...cells(row) })) }
        : { available: false, code: section.code, reason: section.reason, fix: section.fix },
    ]),
  );
}

/** One heading and one table per answered section; an unavailable one is its reason and fix. */
export function renderDiagnostics(report: DbDiagnostics): readonly string[] {
  return Object.entries(report).flatMap(([name, section]: [string, DiagnosticSection<object>]) => {
    if (!section.available) {
      const { code, reason, fix } = section;
      return [msg('cli.db.diagnostics.unavailable', { section: name, code, reason, fix }), ''];
    }
    const rows = section.rows.map(cells);
    const header = Object.keys(rows[0] ?? {});
    const table = renderTable(
      header,
      rows.map((row) => header.map((key) => String(row[key] ?? ''))),
    );
    const body = rows.length === 0 ? [] : table.map((line) => `  ${line}`);
    return [msg('cli.db.diagnostics.section', { section: name, count: rows.length }), ...body, ''];
  });
}

/** The whole `x db diagnostics` budget on an embedded database, its cold boot included. */
export const EMBEDDED_DIAGNOSTICS_DEADLINE_MS = 30_000;

/**
 * `startDb`, not `startQueue`: the queue's boot applies the framework tables, and a diagnostic
 * must write nothing. An embedded database `x dev` holds is refused rather than opened twice:
 * PGlite's data directory has one writer.
 */
export async function runDiagnostics(ctx: CommandContext, root: string): Promise<CommandResult> {
  const limit = readIntFlag(ctx.args, {
    name: 'limit',
    command: 'db diagnostics',
    min: 1,
    max: 1_000,
    example: 'x db diagnostics --limit 20 --json',
  });
  const services = resolveServices(root, ctx.env);
  if (services.db.mode === 'embedded') {
    // Check-then-open, as `x db reset` does: an `x dev` starting between this read and `startDb`
    // below is not seen. Narrow, and the same window every embedded `x db` subcommand has.
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
    // Embedded, the probe IS the boot — a WASM compile and an initdb, 12.6 s cold under coverage —
    // so the 3 s probe wait answered a healthy database X_DB_UNAVAILABLE. A server keeps the default.
    const deadlineMs =
      services.db.mode === 'embedded' ? EMBEDDED_DIAGNOSTICS_DEADLINE_MS : undefined;
    const report = await dbDiagnostics({ client: started.client, limit, deadlineMs });
    const sections = Object.values(report);
    return {
      ok: true,
      command: 'db',
      summary: msg('cli.db.diagnostics.done', {
        available: sections.filter((section) => section.available).length,
        total: sections.length,
      }),
      lines: renderDiagnostics(report),
      data: diagnosticsJson(report),
    };
  } finally {
    await started.client.close();
    await started.replica?.close();
  }
}
